// Bun-native HTTP + WebSocket server for Infinite Canvas MVP
// - Serves static client via Bun.file/Response
// - WebSockets via Bun.serve websocket handlers
// - Persists stroke logs per tile as NDJSON.gz (appendable gzip members)

import path from 'path';
import fs from 'fs';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(import.meta.dir, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'tiles');
const GZIP_LEVEL = Number(process.env.GZIP_LEVEL || 9);
const TILE_SIZE = 1024; // px
const Z = 0; // single resolution for MVP

fs.mkdirSync(LOG_DIR, { recursive: true });

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function fileResponse(filePath) {
  const file = Bun.file(filePath);
  return file.size === 0 && !fs.existsSync(filePath)
    ? new Response('Not Found', { status: 404 })
    : new Response(file);
}

function tileRawPath(z, tx, ty) {
  return path.join(LOG_DIR, String(z), `${tx}_${ty}.ndjson`);
}

function tileGzPath(z, tx, ty) {
  return path.join(LOG_DIR, String(z), `${tx}_${ty}.ndjson.gz`);
}

function ensureDirsFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function migrateRawToGz(z, tx, ty) {
  const raw = tileRawPath(z, tx, ty);
  const gz = tileGzPath(z, tx, ty);
  if (fs.existsSync(raw) && !fs.existsSync(gz)) {
    try {
      const content = fs.readFileSync(raw);
      const out = Bun.gzipSync(content, { level: GZIP_LEVEL });
      ensureDirsFor(gz);
      fs.writeFileSync(gz, out);
      fs.unlinkSync(raw);
    } catch (_) { /* ignore */ }
  }
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

export function tilesForBounds(minX, minY, maxX, maxY, tileSize) {
  const tx0 = Math.floor(minX / tileSize);
  const ty0 = Math.floor(minY / tileSize);
  const tx1 = Math.floor((maxX - 1) / tileSize);
  const ty1 = Math.floor((maxY - 1) / tileSize);
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      tiles.push({ tx, ty });
    }
  }
  return tiles;
}

function bboxOfPoints(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = Number(p.x); const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function appendStrokeToTiles(stroke) {
  const bb = bboxOfPoints(stroke.points || []);
  if (!bb) return [];
  const padding = clamp(Number(stroke.size) || 12, 1, 128) * 2; // include brush radius
  const tiles = tilesForBounds(bb.minX - padding, bb.minY - padding, bb.maxX + padding, bb.maxY + padding, TILE_SIZE);
  const zVal = stroke.z ?? Z;
  const line = JSON.stringify(stroke) + "\n";
  for (const { tx, ty } of tiles) {
    // Append to raw NDJSON to ensure atomicity and simplicity.
    // Compression is handled asynchronously or on read via migration.
    const fRaw = tileRawPath(zVal, tx, ty);
    ensureDirsFor(fRaw);
    fs.appendFileSync(fRaw, line, 'utf8');
  }
  return tiles;
}

async function gunzipConcatAll(data) {
  // Use Web DecompressionStream to handle concatenated gzip members
  try {
    const ds = new DecompressionStream('gzip');
    const stream = new Response(new Blob([data]).stream().pipeThrough(ds));
    const buf = await stream.arrayBuffer();
    return new TextDecoder('utf-8').decode(buf);
  } catch (e) {
    // Fallback to single-member gunzip
    try { return new TextDecoder('utf-8').decode(Bun.gunzipSync(data)); } catch { return ''; }
  }
}

export async function readTileStrokes(z, tx, ty, sinceTs) {
  const gz = tileGzPath(z, tx, ty);
  const raw = tileRawPath(z, tx, ty);
  let text = '';
  try {
    const parts = [];
    if (fs.existsSync(gz)) {
      const data = await fs.promises.readFile(gz);
      parts.push(await gunzipConcatAll(data));
    }
    if (fs.existsSync(raw)) {
      const data = await fs.promises.readFile(raw, 'utf8');
      parts.push(typeof data === 'string' ? data : data.toString());
    }
    if (parts.length === 0) return [];
    text = parts.join('\n');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of text.split(/\n+/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (sinceTs && Number(obj.t) <= Number(sinceTs)) continue;
      out.push(obj);
    } catch (_) {}
  }
  return out;
}
const clients = new Map(); // id -> WebSocket

function broadcast(type, payload, excludeId) {
  const msg = JSON.stringify({ type, payload });
  for (const [id, ws] of clients) {
    if (excludeId && id === excludeId) continue;
    try { ws.send(msg); } catch {}
  }
}

export function startServer(options = {}) {
  let desired = options.port ?? PORT;
  if (desired === 0) desired = 10000 + Math.floor(Math.random() * 50000);
  let server;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      server = Bun.serve({
        port: desired,
  fetch: async (req, srv) => {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    if (pathname === '/ws') {
      if (srv.upgrade(req)) return undefined; // WebSocket upgrade handled
      return new Response('Upgrade failed', { status: 500 });
    }

    // API: health
    if (pathname === '/api/ping' && req.method === 'GET') {
      return jsonResponse({ ok: true });
    }

    // API: fetch strokes for a tile
    if (pathname === '/api/tile-strokes' && req.method === 'GET') {
      const z = Number(searchParams.get('z') ?? Z);
      const tx = Number(searchParams.get('tx'));
      const ty = Number(searchParams.get('ty'));
      const since = searchParams.get('since') ? Number(searchParams.get('since')) : undefined;
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return jsonResponse({ error: 'tx,ty required' }, 400);
      const strokes = await readTileStrokes(z, tx, ty, since);
      return jsonResponse({ z, tx, ty, strokes });
    }

    // API: persist stroke (JSON)
    if (pathname === '/api/stroke' && req.method === 'POST') {
      try {
        const json = await req.json();
        const stroke = {
          id: json.id || crypto.randomUUID(),
          userId: String(json.userId || ''),
          color: String(json.color || '#000000'),
          size: clamp(Number(json.size) || 12, 1, 128),
          opacity: clamp(Number(json.opacity) || 1, 0, 1),
          points: Array.isArray(json.points) ? json.points.map(p => ({ x: Number(p.x), y: Number(p.y), p: Number(p.p || 0) })) : [],
          z: Number(json.z ?? Z),
          t: Date.now(),
          erase: Boolean(json.erase)
        };
        appendStrokeToTiles(stroke);
        return jsonResponse({ ok: true, id: stroke.id, t: stroke.t });
      } catch {
        return jsonResponse({ error: 'invalid json' }, 400);
      }
    }

    // Static client
    if (pathname === '/' || pathname === '/index.html') {
      return fileResponse(path.join(CLIENT_DIR, 'index.html'));
    }
    if (pathname && pathname.startsWith('/')) {
      const safePath = path.normalize(path.join(CLIENT_DIR, pathname));
      if (!safePath.startsWith(CLIENT_DIR)) return new Response('Forbidden', { status: 403 });
      if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        return fileResponse(safePath);
      }
    }
    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      const id = crypto.randomUUID();
      const color = `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`;
      const name = `Guest-${id.slice(0, 4)}`;
      ws.data = { id, color, name, x: 0, y: 0 };
      clients.set(id, ws);

      // Send welcome + current presence snapshot
      const snapshot = [];
      for (const [cid, cws] of clients) {
        if (cid === id) continue;
        const d = cws.data;
        snapshot.push({ id: cid, color: d.color, name: d.name, x: d.x, y: d.y });
      }
      ws.send(JSON.stringify({ type: 'welcome', payload: { id, color, name, others: snapshot } }));
    },
    message(ws, message) {
      let msg;
      try {
        const raw = typeof message === 'string' ? message : (message instanceof Uint8Array ? new TextDecoder('utf-8').decode(message) : String(message));
        msg = JSON.parse(raw);
      } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const { type, payload } = msg;
      const id = ws.data.id;
      if (type === 'presence') {
        if (payload && Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
          ws.data.x = Number(payload.x); ws.data.y = Number(payload.y);
        }
        if (payload && typeof payload.name === 'string') ws.data.name = payload.name.slice(0, 24);
        if (payload && typeof payload.color === 'string') ws.data.color = String(payload.color);
        broadcast('presence', { id, x: ws.data.x, y: ws.data.y, color: ws.data.color, name: ws.data.name }, id);
      } else if (type === 'stroke') {
        const now = Date.now();
        const stroke = {
          id: payload.id || crypto.randomUUID(),
          userId: id,
          color: String(payload.color || '#000'),
          size: clamp(Number(payload.size) || 12, 1, 128),
          opacity: clamp(Number(payload.opacity) || 1, 0, 1),
          points: Array.isArray(payload.points) ? payload.points.map(p => ({ x: Number(p.x), y: Number(p.y), p: Number(p.p || 0) })) : [],
          z: Z,
          t: now,
          erase: Boolean(payload.erase)
        };
        appendStrokeToTiles(stroke);
        broadcast('stroke', stroke, id);
      }
    },
    close(ws) {
      const id = ws.data?.id;
      if (id) {
        clients.delete(id);
        broadcast('leave', { id });
      }
    }
  }
      });
      if (server && server.port) break;
    } catch (e) {
      // pick a random high port if binding failed
      desired = 10000 + Math.floor(Math.random() * 50000);
    }
  }
  if (!server) throw new Error('Failed to start server');
  return server;
}

if (import.meta.main) {
  const srv = startServer();
  console.log(`Infinite Canvas (Bun) listening on http://localhost:${srv.port}`);
}
