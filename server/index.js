// Bun-native HTTP + WebSocket server for Infinite Canvas MVP
// - Serves static client via Bun.file/Response
// - WebSockets via Bun.serve websocket handlers
// - Persists stroke logs per tile as NDJSON.gz (appendable gzip members)

import path from 'path';
import fs from 'fs';
import { Database } from 'bun:sqlite';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(import.meta.dir, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TILE_SIZE = 1024; // px
const Z = 0; // single resolution for MVP

// Initialize SQLite store (Bun native)
const DB_PATH = path.join(DATA_DIR, 'tiles.sqlite3');
// Ensure data directory exists without blocking the event loop
try {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
} catch (e) {
  // best-effort - if this fails later errors will surface when accessing files
}
const db = new Database(DB_PATH);
db.exec(`
  -- Use in-memory journaling to avoid filesystem restrictions (no -wal/-shm files)
  PRAGMA journal_mode = MEMORY;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = memory;
  CREATE TABLE IF NOT EXISTS tile_strokes (
    z   INTEGER NOT NULL,
    tx  INTEGER NOT NULL,
    ty  INTEGER NOT NULL,
    t   INTEGER NOT NULL,
    id  TEXT    NOT NULL,
    json BLOB   NOT NULL -- gzip-compressed JSON
  );
  CREATE INDEX IF NOT EXISTS idx_tile ON tile_strokes (z, tx, ty, t);
`);

const insertStrokeStmt = db.prepare('INSERT INTO tile_strokes (z, tx, ty, t, id, json) VALUES (?, ?, ?, ?, ?, ?)');
const selectTileAllStmt = db.prepare('SELECT json FROM tile_strokes WHERE z=? AND tx=? AND ty=? ORDER BY t ASC');
const selectTileSinceStmt = db.prepare('SELECT json FROM tile_strokes WHERE z=? AND tx=? AND ty=? AND t>? ORDER BY t ASC');

// Database size management - 1GB limit
const MAX_DB_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1GB
const deleteOldestStrokesStmt = db.prepare('DELETE FROM tile_strokes WHERE rowid IN (SELECT rowid FROM tile_strokes ORDER BY t ASC LIMIT ?)');
const getDbSizeStmt = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');
const getStrokeCountStmt = db.prepare('SELECT COUNT(*) as count FROM tile_strokes');

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function fileResponse(filePath) {
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) return new Response('Not Found', { status: 404 });
    return new Response(Bun.file(filePath));
  } catch (e) {
    return new Response('Not Found', { status: 404 });
  }
}

// Legacy file store helpers removed: SQLite is the only storage now.

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// Check database size and remove oldest strokes if over limit
function enforceDbSizeLimit() {
  try {
    const sizeResult = getDbSizeStmt.get();
    const currentSize = sizeResult ? sizeResult.size : 0;
    
    if (currentSize >= MAX_DB_SIZE_BYTES) {
      console.log(`Database size (${Math.round(currentSize / (1024 * 1024))}MB) approaching limit. Cleaning up oldest strokes...`);
      
      // Remove oldest 10% of strokes to free up space
      const countResult = getStrokeCountStmt.get();
      const totalStrokes = countResult ? countResult.count : 0;
      
      if (totalStrokes > 0) {
        const strokesToDelete = Math.max(1, Math.floor(totalStrokes * 0.1));
        deleteOldestStrokesStmt.run(strokesToDelete);
        
        // Run VACUUM to reclaim space immediately
        db.exec('VACUUM');
        
        const newSizeResult = getDbSizeStmt.get();
        const newSize = newSizeResult ? newSizeResult.size : 0;
        
        console.log(`Cleanup complete. Removed ${strokesToDelete} oldest strokes. Database size reduced from ${Math.round(currentSize / (1024 * 1024))}MB to ${Math.round(newSize / (1024 * 1024))}MB`);
      }
    }
  } catch (error) {
    console.warn('Failed to enforce database size limit:', error.message);
  }
}

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
  
  // Enforce database size limit before adding new strokes
  enforceDbSizeLimit();
  
  const padding = clamp(Number(stroke.size) || 12, 1, 128) * 2; // include brush radius
  const tiles = tilesForBounds(bb.minX - padding, bb.minY - padding, bb.maxX + padding, bb.maxY + padding, TILE_SIZE);
  const zVal = stroke.z ?? Z;
  const DB_GZIP_LEVEL = Number(process.env.DB_GZIP_LEVEL || 9);
  const jsonBuf = Bun.gzipSync(JSON.stringify(stroke), { level: DB_GZIP_LEVEL });
  const tVal = Number(stroke.t) || Date.now();
  const idVal = String(stroke.id || '');
  const txInsert = db.transaction((list) => {
    for (const { tx, ty } of list) {
      insertStrokeStmt.run(zVal, tx, ty, tVal, idVal, jsonBuf);
    }
  });
  try { txInsert(tiles); } catch (e) { console.warn('DB insert failed', (e && e.message) || e); }
  return tiles;
}

export async function readTileStrokes(z, tx, ty, sinceTs) {
  try {
    const rows = (sinceTs != null)
      ? selectTileSinceStmt.all(z, tx, ty, Number(sinceTs))
      : selectTileAllStmt.all(z, tx, ty);
    const out = [];
    for (const r of rows) {
      try {
        const data = r.json;
        if (typeof data === 'string') {
          out.push(JSON.parse(data));
        } else if (data && (data instanceof Uint8Array || ArrayBuffer.isView(data))) {
          const raw = Bun.gunzipSync(data);
          const str = new TextDecoder('utf-8').decode(raw);
          out.push(JSON.parse(str));
        }
      } catch {}
    }
    return out;
  } catch (_) {
    return [];
  }
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

    // API: database status
    if (pathname === '/api/db-status' && req.method === 'GET') {
      try {
        const sizeResult = getDbSizeStmt.get();
        const countResult = getStrokeCountStmt.get();
        const currentSize = sizeResult ? sizeResult.size : 0;
        const strokeCount = countResult ? countResult.count : 0;
        
        return jsonResponse({
          sizeBytes: currentSize,
          sizeMB: Math.round(currentSize / (1024 * 1024)),
          maxSizeBytes: MAX_DB_SIZE_BYTES,
          maxSizeMB: Math.round(MAX_DB_SIZE_BYTES / (1024 * 1024)),
          strokeCount,
          utilizationPercent: Math.round((currentSize / MAX_DB_SIZE_BYTES) * 100)
        });
      } catch (error) {
        return jsonResponse({ error: 'Failed to get database status', details: error.message }, 500);
      }
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

    // API: batch fetch strokes for multiple tiles
    if (pathname === '/api/tile-strokes-batch' && req.method === 'POST') {
      try {
        const body = await req.json();
        const z = Number(body?.z ?? Z);
        const tilesArr = Array.isArray(body?.tiles) ? body.tiles : [];
        // Limit tiles per batch to avoid abuse
        const MAX_BATCH = 500;
        if (tilesArr.length === 0) return jsonResponse({ tiles: [] });
        if (tilesArr.length > MAX_BATCH) return jsonResponse({ error: 'too many tiles requested' }, 400);
        const out = [];
        for (const t of tilesArr) {
          const tx = Number(t?.tx);
          const ty = Number(t?.ty);
          if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
          const strokes = await readTileStrokes(z, tx, ty);
          out.push({ z, tx, ty, strokes });
        }
        return jsonResponse({ tiles: out });
      } catch (e) {
        return jsonResponse({ error: 'invalid json' }, 400);
      }
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
        try { appendStrokeToTiles(stroke); } catch (_) {}
        return jsonResponse({ ok: true, id: stroke.id, t: stroke.t });
      } catch {
        return jsonResponse({ error: 'invalid json' }, 400);
      }
    }

    // Static client
    if (pathname === '/' || pathname === '/index.html') {
      return await fileResponse(path.join(CLIENT_DIR, 'index.html'));
    }
    if (pathname && pathname.startsWith('/')) {
      const safePath = path.normalize(path.join(CLIENT_DIR, pathname));
      if (!safePath.startsWith(CLIENT_DIR)) return new Response('Forbidden', { status: 403 });
      try {
        const st = await fs.promises.stat(safePath);
        if (st.isFile()) return await fileResponse(safePath);
      } catch (e) {
        // fallthrough to 404
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
  async message(ws, message) {
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
        try { appendStrokeToTiles(stroke); } catch (_) {}
        broadcast('stroke', stroke, id);
      } else if (type === 'tilesRequest') {
        // Stream tile data back to the requesting socket, one message per tile.
        // payload: { reqId, z, tiles: [{tx,ty}, ...] }
        try {
          const reqId = payload?.reqId || null;
          const zVal = Number(payload?.z ?? Z);
          const tilesArr = Array.isArray(payload?.tiles) ? payload.tiles : [];
          // limit tiles per request to avoid abuse
          const MAX_BATCH = 1000;
          if (tilesArr.length === 0) {
            ws.send(JSON.stringify({ type: 'tileBatchDone', payload: { reqId } }));
            return;
          }
          if (tilesArr.length > MAX_BATCH) {
            // send done immediately
            ws.send(JSON.stringify({ type: 'tileBatchDone', payload: { reqId } }));
            return;
          }
          for (const t of tilesArr) {
            const tx = Number(t?.tx);
            const ty = Number(t?.ty);
            if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
            try {
              const strokes = await readTileStrokes(zVal, tx, ty);
              // send each tile as its own message so client can stream-parse them
              ws.send(JSON.stringify({ type: 'tileData', payload: { reqId, z: zVal, tx, ty, strokes } }));
            } catch (e) {
              // continue on error per-tile
              try { ws.send(JSON.stringify({ type: 'tileData', payload: { reqId, z: zVal, tx, ty, strokes: [] } })); } catch {}
            }
          }
          // Indicate completion
          try { ws.send(JSON.stringify({ type: 'tileBatchDone', payload: { reqId } })); } catch {}
        } catch (e) {
          // ignore
        }
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
  
  // Set up periodic database monitoring (every 5 minutes)
  setInterval(() => {
    try {
      const sizeResult = getDbSizeStmt.get();
      const currentSize = sizeResult ? sizeResult.size : 0;
      const sizeMB = Math.round(currentSize / (1024 * 1024));
      const utilization = Math.round((currentSize / MAX_DB_SIZE_BYTES) * 100);
      
      if (utilization >= 80) {
        console.log(`Database size warning: ${sizeMB}MB (${utilization}% of 1GB limit)`);
      }
    } catch (error) {
      console.warn('Failed to check database size:', error.message);
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  return server;
}

if (import.meta.main) {
  const srv = startServer();
  console.log(`Infinite Canvas (Bun) listening on http://localhost:${srv.port}`);
  
  // Log initial database status
  try {
    const sizeResult = getDbSizeStmt.get();
    const countResult = getStrokeCountStmt.get();
    const currentSize = sizeResult ? sizeResult.size : 0;
    const strokeCount = countResult ? countResult.count : 0;
    const sizeMB = Math.round(currentSize / (1024 * 1024));
    console.log(`Database initialized: ${sizeMB}MB used (${strokeCount} strokes), 1GB limit enforced`);
  } catch (error) {
    console.warn('Failed to get initial database status:', error.message);
  }
}
