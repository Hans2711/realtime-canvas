// Worker that performs network fetching and JSON parsing off the main thread.
// Supports two messages:
// { type: 'fetchTile', id, tx, ty, z }
//   -> posts { type: 'tileResult', id, tx, ty, z, strokes }
// { type: 'batchFetch', id, z, tiles }
//   -> posts { type: 'batchResult', id, tiles }

const q = new Map(); // debounce map key -> { timer, callers: [id,...] }

function tileKey(tx, ty, z) { return `${z}:${tx}:${ty}`; }
// Persistent websocket used by the worker to request tiles
let ws = null;
let wsReady = false;
const pending = new Map(); // reqId -> { type:'tile'|'batch', resolve, reject, out:[], timer }

function ensureWS() {
  if (ws) return ws;
  try {
    const proto = (self.location && self.location.protocol === 'https:') ? 'wss:' : 'ws:';
    const host = (self.location && self.location.host) ? self.location.host : null;
    ws = new WebSocket(`${proto}//${host}/ws`);
  } catch (e) {
    ws = null;
    return null;
  }
  ws.addEventListener('open', () => { wsReady = true; });
  // Identify as tiles channel (server -> client streaming for tile data)
  ws.addEventListener('open', () => { try { ws.send(JSON.stringify({ type: 'identify', payload: { role: 'tiles' } })); } catch {} });
  ws.addEventListener('close', () => { wsReady = false; ws = null; /* reconnect later on demand */ });
  ws.addEventListener('error', () => { /* ignore */ });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
    const { type, payload } = msg || {};
    if (!payload) return;
    if (type === 'tileData') {
      const reqId = payload.reqId;
      const p = pending.get(reqId);
      if (!p) return;
      if (p.type === 'tile') {
        // resolve immediately with strokes
        try { p.resolve(Array.isArray(payload.strokes) ? payload.strokes : []); } catch {}
        clearTimeout(p.timer); pending.delete(reqId);
      } else if (p.type === 'batch') {
        p.out.push(payload);
        // post incremental tile to main thread
        self.postMessage({ type: 'batchTile', id: p.id, tile: payload });
      }
    } else if (type === 'tileBatchDone') {
      const reqId = payload.reqId;
      const p = pending.get(reqId);
      if (!p) return;
      if (p.type === 'batch') {
        try { p.resolve(p.out); } catch {}
        clearTimeout(p.timer); pending.delete(reqId);
      }
    }
  });
  return ws;
}

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  const { type } = msg;
  if (type === 'fetchTile') {
    const { id, tx, ty, z = 0 } = msg;
    // debounce similar to main thread (200ms) to avoid duplicate requests
    const k = tileKey(tx, ty, z);
    let entry = q.get(k);
    if (!entry) {
      entry = { callers: [], timer: null };
      q.set(k, entry);
      entry.timer = setTimeout(() => {
        q.delete(k);
        (async () => {
          const ws = ensureWS();
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            // no ws available -> reply empty
            for (const cid of entry.callers) self.postMessage({ type: 'tileResult', id: cid, tx, ty, z, strokes: [] });
            return;
          }
          const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
          try {
            const p = new Promise((resolve, reject) => {
              const timer = setTimeout(() => { reject(new Error('timeout')); pending.delete(reqId); }, 10000);
              pending.set(reqId, { type: 'tile', resolve, reject, timer });
            });
            ws.send(JSON.stringify({ type: 'tilesRequest', payload: { reqId, z, tiles: [{ tx, ty }] } }));
            const strokes = await p.catch(() => []);
            for (const cid of entry.callers) self.postMessage({ type: 'tileResult', id: cid, tx, ty, z, strokes });
          } catch (e) {
            for (const cid of entry.callers) self.postMessage({ type: 'tileResult', id: cid, tx, ty, z, strokes: [] });
          }
        })();
      }, 200);
    }
    entry.callers.push(id);
    return;
  }

  if (type === 'batchFetch') {
    const { id, z = 0, tiles } = msg;
    (async () => {
      const ws = ensureWS();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        self.postMessage({ type: 'batchResult', id, tiles: [] });
        return;
      }
      const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      try {
        const out = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(reqId); resolve([]); }, 15000);
          pending.set(reqId, { type: 'batch', resolve, reject, out: [], id, timer });
          try { ws.send(JSON.stringify({ type: 'tilesRequest', payload: { reqId, z, tiles } })); } catch (e) { clearTimeout(timer); pending.delete(reqId); resolve([]); }
        });
        self.postMessage({ type: 'batchResult', id, tiles: out });
      } catch (e) {
        self.postMessage({ type: 'batchResult', id, tiles: [] });
      }
    })();
    return;
  }
});
