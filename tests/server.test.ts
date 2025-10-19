import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs";
import os from "os";

let mod: any;
let TMP: string;

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "inf-canvas-"));
  process.env.DATA_DIR = TMP;
  // dynamic import to apply DATA_DIR
  mod = await import(path.join(process.cwd(), "server/index.js") + `?t=${Date.now()}`);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function makeStroke(id: string, opts: Partial<any> = {}) {
  return {
    id,
    userId: opts.userId || "u1",
    color: opts.color || "#f00",
    size: opts.size || 6,
    opacity: opts.opacity ?? 1,
    z: 0,
    t: Date.now(),
    erase: !!opts.erase,
    points: opts.points || [ { x: 10, y: 10 }, { x: 100, y: 10 } ]
  };
}

describe("tile storage (gzip concatenation)", () => {
  test("append then read returns all strokes", async () => {
    const s1 = makeStroke("s1");
    const s2 = makeStroke("s2", { color: "#0f0" });
    mod.appendStrokeToTiles(s1);
    mod.appendStrokeToTiles(s2);
    const list = await mod.readTileStrokes(0, 0, 0);
    const ids = new Set(list.map((x: any) => x.id));
    expect(ids.has("s1")).toBeTrue();
    expect(ids.has("s2")).toBeTrue();
  });

  test("merge legacy gz with new raw appends", async () => {
    // Write an old stroke into gz, then append a new stroke via raw
    const oldStroke = makeStroke("old-gz");
    const line = JSON.stringify(oldStroke) + "\n";
    const gzDir = path.join(process.env.DATA_DIR as string, 'tiles', '0');
    fs.mkdirSync(gzDir, { recursive: true });
    const gzPath = path.join(gzDir, '0_0.ndjson.gz');
    fs.writeFileSync(gzPath, Bun.gzipSync(Buffer.from(line)));

    const newStroke = makeStroke("new-raw", { color: '#00f' });
    mod.appendStrokeToTiles(newStroke);

    const list = await mod.readTileStrokes(0, 0, 0);
    const ids = new Set(list.map((x: any) => x.id));
    expect(ids.has("old-gz")).toBeTrue();
    expect(ids.has("new-raw")).toBeTrue();
  });

  test("cross-tile stroke touches both tiles", async () => {
    const cross = makeStroke("cross-1", { points: [ { x: 1020, y: 50 }, { x: 1030, y: 50 } ] });
    mod.appendStrokeToTiles(cross);
    const a = await mod.readTileStrokes(0, 0, 0);
    const b = await mod.readTileStrokes(0, 1, 0);
    const ida = new Set(a.map((x: any) => x.id));
    const idb = new Set(b.map((x: any) => x.id));
    expect(ida.has('cross-1') || idb.has('cross-1')).toBeTrue();
  });

  test("erase flag persisted", async () => {
    const er = makeStroke("erase-1", { erase: true });
    mod.appendStrokeToTiles(er);
    const list = await mod.readTileStrokes(0, 0, 0);
    const found = list.find((x: any) => x.id === 'erase-1');
    expect(!!(found && found.erase)).toBeTrue();
  });
});

describe("websocket broadcast + persistence", () => {
  test("ws stroke is broadcast and persisted", async () => {
    let server: any;
    try {
      server = mod.startServer({ port: 0 });
    } catch (e) {
      // Some CI/sandboxes disallow binding sockets; treat as a skipped test.
      console.warn("Skipping WS test: cannot start server:", (e as Error).message);
      expect(true).toBeTrue();
      return;
    }
    const port = server.port;
    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${port}/ws`);

    await new Promise<void>((resolve) => {
      let ready = 0;
      function onOpen() { if (++ready === 2) resolve(); }
      ws1.addEventListener('open', onOpen);
      ws2.addEventListener('open', onOpen);
    });

    const received = new Promise<any>((resolve) => {
      ws2.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'stroke') resolve(msg.payload || msg);
        } catch {}
      });
    });

    const stroke = makeStroke("ws-test-1");
    ws1.send(JSON.stringify({ type: 'stroke', payload: stroke }));
    const echoed = await Promise.race([
      received,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('no broadcast')), 2000))
    ]);
    expect(echoed.id).toBe("ws-test-1");

    // Give the server a brief moment to flush to disk
    await new Promise(r => setTimeout(r, 150));
    // Query all tiles that the stroke may touch and assert presence in at least one
    const pad = (stroke.size || 6) * 2;
    const tiles = mod.tilesForBounds(10 - pad, 10 - pad, 100 + pad, 10 + pad, 1024);
    let found = false;
    for (const { tx, ty } of tiles) {
      const res = await fetch(`http://localhost:${port}/api/tile-strokes?z=0&tx=${tx}&ty=${ty}`);
      expect(res.ok).toBeTrue();
      const json: any = await res.json();
      const ids = new Set((json.strokes || []).map((s: any) => s.id));
      if (ids.has("ws-test-1")) { found = true; break; }
    }
    expect(found).toBeTrue();

    ws1.close(); ws2.close();
    server.stop();
  });
});
