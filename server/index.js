// Bun-native HTTP + WebSocket server for Infinite Canvas
// Compact array protocol to minimize WS payloads.

import path from 'path';
import fs from 'fs';
import { Database } from 'bun:sqlite';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(import.meta.dir, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TILE_SIZE = 1024;
const Z = 0;

const DB_PATH = path.join(DATA_DIR, 'tiles.sqlite3');
try { await fs.promises.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
const db = new Database(DB_PATH);
db.exec(`
  PRAGMA journal_mode = MEMORY;
  PRAGMA synchronous = OFF;
  PRAGMA temp_store = memory;
  CREATE TABLE IF NOT EXISTS tile_strokes (
    z INTEGER NOT NULL,
    tx INTEGER NOT NULL,
    ty INTEGER NOT NULL,
    t INTEGER NOT NULL,
    id TEXT NOT NULL,
    json BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tile ON tile_strokes (z, tx, ty, t);
`);

const insertStrokeStmt = db.prepare('INSERT INTO tile_strokes (z, tx, ty, t, id, json) VALUES (?, ?, ?, ?, ?, ?)');
const selectTileAllStmt = db.prepare('SELECT json FROM tile_strokes WHERE z=? AND tx=? AND ty=? ORDER BY t ASC');
const selectTileSinceStmt = db.prepare('SELECT json FROM tile_strokes WHERE z=? AND tx=? AND ty=? AND t>? ORDER BY t ASC');

const MAX_DB_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1GB
const deleteOldestStrokesStmt = db.prepare('DELETE FROM tile_strokes WHERE rowid IN (SELECT rowid FROM tile_strokes ORDER BY t ASC LIMIT ?)');
const getDbSizeStmt = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');
const getStrokeCountStmt = db.prepare('SELECT COUNT(*) as count FROM tile_strokes');

function jsonResponse(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
async function fileResponse(filePath) { try { const s = await fs.promises.stat(filePath); if (!s.isFile()) return new Response('Not Found', { status: 404 }); return new Response(Bun.file(filePath)); } catch { return new Response('Not Found', { status: 404 }); } }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function enforceDbSizeLimit() {
  try {
    const sizeResult = getDbSizeStmt.get(); const currentSize = sizeResult ? sizeResult.size : 0;
    if (currentSize >= MAX_DB_SIZE_BYTES) {
      const countResult = getStrokeCountStmt.get(); const totalStrokes = countResult ? countResult.count : 0;
      if (totalStrokes > 0) { const strokesToDelete = Math.max(1, Math.floor(totalStrokes * 0.1)); deleteOldestStrokesStmt.run(strokesToDelete); db.exec('VACUUM'); }
    }
  } catch (e) { console.warn('enforceDbSizeLimit failed', e && e.message); }
}

function bboxOfPoints(pts) { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const p of pts) { const x = Number(p.x); const y = Number(p.y); if (!Number.isFinite(x) || !Number.isFinite(y)) continue; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; } if (!Number.isFinite(minX)) return null; return { minX, minY, maxX, maxY }; }

export function appendStrokeToTiles(stroke) {
  const bb = bboxOfPoints(stroke.points || []); if (!bb) return [];
  enforceDbSizeLimit();
  const padding = clamp(Number(stroke.size) || 12, 1, 128) * 2;
  const tx0 = Math.floor((bb.minX - padding) / TILE_SIZE); const ty0 = Math.floor((bb.minY - padding) / TILE_SIZE);
  const tx1 = Math.floor((bb.maxX + padding - 1) / TILE_SIZE); const ty1 = Math.floor((bb.maxY + padding - 1) / TILE_SIZE);
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push({ tx, ty });
  const zVal = stroke.z ?? Z; const jsonBuf = Bun.gzipSync(JSON.stringify(stroke), { level: Number(process.env.DB_GZIP_LEVEL || 9) }); const tVal = Number(stroke.t) || Date.now(); const idVal = String(stroke.id || '');
  const txInsert = db.transaction((list) => { for (const { tx, ty } of list) insertStrokeStmt.run(zVal, tx, ty, tVal, idVal, jsonBuf); });
  try { txInsert(tiles); } catch (e) { console.warn('DB insert failed', e && e.message); }
  return tiles;
}

export async function readTileStrokes(z, tx, ty, sinceTs) {
  try {
    const rows = (sinceTs != null) ? selectTileSinceStmt.all(z, tx, ty, Number(sinceTs)) : selectTileAllStmt.all(z, tx, ty);
    const out = [];
    for (const r of rows) {
      try {
        const data = r.json;
        if (typeof data === 'string') out.push(JSON.parse(data));
        else if (data && (data instanceof Uint8Array || ArrayBuffer.isView(data))) { const raw = Bun.gunzipSync(data); const str = new TextDecoder('utf-8').decode(raw); out.push(JSON.parse(str)); }
      } catch {}
    }
    return out;
  } catch (_) { return []; }
}

const clients = new Map(); // id -> ws

// Protocol opcodes (compact arrays)
// 0 identify, 1 presence, 2 stroke, 3 tilesRequest, 4 tileData, 5 welcome, 6 tileBatchDone, 7 leave

function broadcastArray(arr, excludeId) { const msg = JSON.stringify(arr); for (const [id, ws] of clients) { if (excludeId && id === excludeId) continue; try { ws.send(msg); } catch {} } }

export function startServer(options = {}) {
  let desired = options.port ?? PORT; if (desired === 0) desired = 10000 + Math.floor(Math.random() * 50000);
  let server;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      server = Bun.serve({
        port: desired,
        fetch: async (req, srv) => {
          const url = new URL(req.url);
          const { pathname, searchParams } = url;

          if (pathname === '/ws') {
            if (srv.upgrade(req)) return undefined;
            return new Response('Upgrade failed', { status: 500 });
          }

          if (pathname === '/api/ping' && req.method === 'GET') return jsonResponse({ ok: true });

          if (pathname === '/api/db-status' && req.method === 'GET') {
            try {
              const sizeResult = getDbSizeStmt.get();
              const countResult = getStrokeCountStmt.get();
              const currentSize = sizeResult ? sizeResult.size : 0;
              const strokeCount = countResult ? countResult.count : 0;
              return jsonResponse({ sizeBytes: currentSize, sizeMB: Math.round(currentSize / (1024 * 1024)), maxSizeBytes: MAX_DB_SIZE_BYTES, maxSizeMB: Math.round(MAX_DB_SIZE_BYTES / (1024 * 1024)), strokeCount, utilizationPercent: Math.round((currentSize / MAX_DB_SIZE_BYTES) * 100) });
            } catch (e) { return jsonResponse({ error: 'Failed to get database status', details: e.message }, 500); }
          }

          if (pathname === '/api/tile-strokes' && req.method === 'GET') {
            const z = Number(searchParams.get('z') ?? Z);
            const tx = Number(searchParams.get('tx'));
            const ty = Number(searchParams.get('ty'));
            const since = searchParams.get('since') ? Number(searchParams.get('since')) : undefined;
            if (!Number.isFinite(tx) || !Number.isFinite(ty)) return jsonResponse({ error: 'tx,ty required' }, 400);
            const strokes = await readTileStrokes(z, tx, ty, since);
            return jsonResponse({ z, tx, ty, strokes });
          }

          if (pathname === '/api/tile-strokes-batch' && req.method === 'POST') {
            try {
              const body = await req.json();
              const z = Number(body?.z ?? Z);
              const tilesArr = Array.isArray(body?.tiles) ? body.tiles : [];
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
            } catch (e) { return jsonResponse({ error: 'invalid json' }, 400); }
          }

          if (pathname === '/api/stroke' && req.method === 'POST') {
            try {
              const json = await req.json();
              const stroke = { id: json.id || crypto.randomUUID(), userId: String(json.userId || ''), color: String(json.color || '#000000'), size: clamp(Number(json.size) || 12, 1, 128), opacity: clamp(Number(json.opacity) || 1, 0, 1), points: Array.isArray(json.points) ? json.points.map(p => ({ x: Number(p.x), y: Number(p.y), p: Number(p.p || 0) })) : [], z: Number(json.z ?? Z), t: Date.now(), erase: Boolean(json.erase) };
              try { appendStrokeToTiles(stroke); } catch (_) {}
              return jsonResponse({ ok: true, id: stroke.id, t: stroke.t });
            } catch (e) { return jsonResponse({ error: 'invalid json' }, 400); }
          }

          if (pathname === '/' || pathname === '/index.html') return await fileResponse(path.join(CLIENT_DIR, 'index.html'));
          if (pathname && pathname.startsWith('/')) {
            const safePath = path.normalize(path.join(CLIENT_DIR, pathname));
            if (!safePath.startsWith(CLIENT_DIR)) return new Response('Forbidden', { status: 403 });
            try { const st = await fs.promises.stat(safePath); if (st.isFile()) return await fileResponse(safePath); } catch {}
          }
          return new Response('Not Found', { status: 404 });
        },
        websocket: {
          open: (ws) => { ws.data = { role: null }; },
          message: async (ws, message) => {
            let raw;
            try { raw = typeof message === 'string' ? message : (message instanceof Uint8Array ? new TextDecoder('utf-8').decode(message) : String(message)); } catch { return; }
            let parsed; try { parsed = JSON.parse(raw); } catch { return; }
            if (!parsed) return;
            // Support both object and array protocols
            let type = null; let payload = null;
            if (Array.isArray(parsed)) {
              const op = parsed[0];
              switch (op) {
                case 0: type = 'identify'; payload = { role: parsed[1] === 1 ? 'tiles' : 'peer' }; break;
                case 1: type = 'presence'; payload = { id: parsed[1], x: parsed[2], y: parsed[3], color: parsed[4], name: parsed[5] }; break;
                case 2: {
                  const pts = [];
                  const flat = Array.isArray(parsed[7]) ? parsed[7] : [];
                  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
                  payload = { id: parsed[1], userId: parsed[2], color: parsed[3], size: parsed[4], opacity: parsed[5], erase: !!parsed[6], points: pts };
                  type = 'stroke';
                  break;
                }
                case 3: type = 'tilesRequest'; payload = { reqId: parsed[1], z: parsed[2], tiles: Array.isArray(parsed[3]) ? parsed[3].map(t => ({ tx: t[0], ty: t[1] })) : [] }; break;
                case 4: type = 'tileData'; payload = { reqId: parsed[1], z: parsed[2], tx: parsed[3], ty: parsed[4], strokes: Array.isArray(parsed[5]) ? parsed[5].map(s => ({ id: s[0], userId: s[1], color: s[2], size: s[3], opacity: s[4], erase: !!s[5], points: (Array.isArray(s[6]) ? (() => { const a=[]; for (let i=0;i<s[6].length;i+=2) a.push({x:s[6][i], y:s[6][i+1]}); return a; })() : []) })) : [] }; break;
                case 6: type = 'tileBatchDone'; payload = { reqId: parsed[1] }; break;
                case 5: type = 'welcome'; payload = { id: parsed[1], color: parsed[2], name: parsed[3], others: Array.isArray(parsed[4]) ? parsed[4].map(x => ({ id: x[0], x: x[1], y: x[2] })) : [] }; break;
                case 7: type = 'leave'; payload = { id: parsed[1] }; break;
                default: return;
              }
            } else if (typeof parsed === 'object') { type = parsed.type; payload = parsed.payload; }

            // Identification
            if (type === 'identify') {
              const role = payload && payload.role === 'tiles' ? 'tiles' : (payload && payload.role === 'peer' ? 'peer' : null);
              if (role === 'peer') {
                const idNew = crypto.randomUUID(); const color = `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`; const name = `Guest-${idNew.slice(0, 4)}`;
                ws.data = { role: 'peer', id: idNew, color, name, x: 0, y: 0 };
                clients.set(idNew, ws);
                // send compact welcome [5, id, color, name, [[id,x,y],...]]
                const snapshot = [];
                for (const [cid, cws] of clients) { if (cid === idNew) continue; const d = cws.data; snapshot.push([cid, d.x, d.y]); }
                try { ws.send(JSON.stringify([5, idNew, color, name, snapshot])); } catch {}
              } else if (role === 'tiles') { ws.data.role = 'tiles'; }
              return;
            }

            if (ws.data && ws.data.role === 'peer' && type === 'presence') {
              if (payload && Number.isFinite(payload.x) && Number.isFinite(payload.y)) { ws.data.x = Number(payload.x); ws.data.y = Number(payload.y); }
              if (payload && typeof payload.name === 'string') ws.data.name = payload.name.slice(0, 24);
              if (payload && typeof payload.color === 'string') ws.data.color = String(payload.color);
              broadcastArray([1, payload.id, ws.data.x, ws.data.y, ws.data.color, ws.data.name], payload.id);
            } else if (ws.data && ws.data.role === 'peer' && type === 'stroke') {
              const now = Date.now();
              const stroke = { id: payload.id || crypto.randomUUID(), userId: payload.userId || ws.data.id || '', color: String(payload.color || '#000'), size: clamp(Number(payload.size) || 12, 1, 128), opacity: clamp(Number(payload.opacity) || 1, 0, 1), points: Array.isArray(payload.points) ? payload.points.map(p => ({ x: Number(p.x), y: Number(p.y), p: Number(p.p || 0) })) : [], z: Z, t: now, erase: Boolean(payload.erase) };
              try { appendStrokeToTiles(stroke); } catch (_) {}
              const ptsFlat = [];
              for (const p of stroke.points) { ptsFlat.push(Number(p.x)); ptsFlat.push(Number(p.y)); }
              broadcastArray([2, stroke.id, stroke.userId, stroke.color, stroke.size, stroke.opacity, stroke.erase ? 1 : 0, ptsFlat], payload.id);
            } else if (type === 'tilesRequest') {
              // Only accept tilesRequest from connections that identified as 'tiles'
              try {
                if (!ws.data || ws.data.role !== 'tiles') return;
                const reqId = payload?.reqId || null;
                const zVal = Number(payload?.z ?? Z);
                const tilesArr = Array.isArray(payload?.tiles) ? payload.tiles : [];
                const MAX_BATCH = 1000;
                if (tilesArr.length === 0) { try { ws.send(JSON.stringify([6, reqId])); } catch {} ; return; }
                if (tilesArr.length > MAX_BATCH) { try { ws.send(JSON.stringify([6, reqId])); } catch {} ; return; }
                for (const t of tilesArr) {
                  const tx = Number(t?.tx);
                  const ty = Number(t?.ty);
                  if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
                  try {
                    const strokes = await readTileStrokes(zVal, tx, ty);
                    const compact = [];
                    for (const s of strokes) { const pts = []; for (const p of s.points || []) { pts.push(Number(p.x)); pts.push(Number(p.y)); } compact.push([s.id, s.userId || '', s.color || '#000', s.size || 4, s.opacity || 1, s.erase ? 1 : 0, pts]); }
                    try { ws.send(JSON.stringify([4, reqId, zVal, tx, ty, compact])); } catch {}
                  } catch (e) { try { ws.send(JSON.stringify([4, reqId, zVal, tx, ty, []])); } catch {} }
                }
                try { ws.send(JSON.stringify([6, reqId])); } catch {}
              } catch (e) { return; }
            } else if (type === 'tileData') {
              // compatibility path - ignore from peers
            } else if (type === 'tileBatchDone') {
              // noop
            }
          },
          close: (ws) => { const id = ws.data?.id; if (id) { clients.delete(id); broadcastArray([7, id], null); } }
        }
      });
      if (server && server.port) break;
    } catch (e) { desired = 10000 + Math.floor(Math.random() * 50000); }
  }
  if (!server) throw new Error('Failed to start server');

  setInterval(() => { try { const sizeResult = getDbSizeStmt.get(); const currentSize = sizeResult ? sizeResult.size : 0; const sizeMB = Math.round(currentSize / (1024 * 1024)); const utilization = Math.round((currentSize / MAX_DB_SIZE_BYTES) * 100); if (utilization >= 80) console.log(`Database size warning: ${sizeMB}MB (${utilization}% of 1GB limit)`); } catch (error) { console.warn('Failed to check database size:', error.message); } }, 5 * 60 * 1000);

  return server;
}

if (import.meta.main) { const srv = startServer(); console.log(`Infinite Canvas (Bun) listening on http://localhost:${srv.port}`); try { const sizeResult = getDbSizeStmt.get(); const countResult = getStrokeCountStmt.get(); const currentSize = sizeResult ? sizeResult.size : 0; const strokeCount = countResult ? countResult.count : 0; const sizeMB = Math.round(currentSize / (1024 * 1024)); console.log(`Database initialized: ${sizeMB}MB used (${strokeCount} strokes), 1GB limit enforced`); } catch (error) { console.warn('Failed to get initial database status:', error.message); } }
