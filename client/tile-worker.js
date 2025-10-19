// Service Worker for background tile fetching and processing
// This prevents stuttering during canvas panning by handling tile requests off the main thread

const CACHE_NAME = 'infinite-canvas-tiles-v1';
const TILE_CACHE_MAX = 512; // Increased cache size for worker
const FETCH_DEBOUNCE_MS = 50; // Debounce tile fetches

// In-memory cache for processed tile data
let tileCache = new Map();
let pendingFetches = new Map();

// Compatibility shim: ensure a global `postMessage` exists so older
// or cached worker code that calls the bare function doesn't throw.
// This proxies to the appropriate API depending on the environment.
try {
  if (typeof postMessage === 'undefined') {
    /* eslint-disable no-var */
    var postMessage = function(msg) {
      try {
        // ServiceWorker: send to window clients
        if (self && self.clients && typeof self.clients.matchAll === 'function') {
          self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            for (const c of clients) {
              try { c.postMessage(msg); } catch (e) { /* ignore */ }
            }
          }).catch(() => { /* ignore */ });
          return;
        }

        // Dedicated worker / global runtime
        if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
          try { self.postMessage(msg); return; } catch (e) { /* ignore */ }
        }

        // Last resort
        if (typeof globalThis !== 'undefined' && typeof globalThis.postMessage === 'function') {
          try { globalThis.postMessage(msg); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* swallow */ }
    };
    /* eslint-enable no-var */
  }
} catch (e) { /* ignore environments where even checking postMessage fails */ }

// Install event - cache essential resources
self.addEventListener('install', (event) => {
  console.log('[TileWorker] Installing service worker');
  self.skipWaiting();
});

// Activate event - claim clients immediately
self.addEventListener('activate', (event) => {
  console.log('[TileWorker] Activating service worker');
  event.waitUntil(clients.claim());
});

// Message handler for communication with main thread
// Helper to safely broadcast a message to all window clients
function broadcast(msg) {
  try {
    // DedicatedWorker context: send directly via postMessage
    if (typeof self.postMessage === 'function' && !(self.clients && typeof self.clients.matchAll === 'function')) {
      try { self.postMessage(msg); return; } catch (e) { /* ignore and fallback */ }
    }

  // ServiceWorker context: broadcast to all window clients
    if (self && self.clients && typeof self.clients.matchAll === 'function') {
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        for (const c of clients) {
          try { c.postMessage(msg); } catch (e) { /* ignore */ }
        }
      }).catch(() => { /* ignore */ });
      return;
    }

    // Last-resort: try globalThis.postMessage if present
    if (typeof globalThis !== 'undefined' && typeof globalThis.postMessage === 'function') {
      try { globalThis.postMessage(msg); return; } catch (e) { /* ignore */ }
    }
  } catch (e) {
    /* swallow errors to avoid crashing the worker */
  }
}

self.addEventListener('message', async (event) => {
  const { type, id, payload } = event.data;
  try {
    switch (type) {
      case 'FETCH_TILE_STROKES':
        await handleFetchTileStrokes(id, payload);
        break;
      case 'FETCH_TILE_STROKES_BATCH':
        await handleFetchTileStrokesBatch(id, payload);
        break;
      case 'CACHE_TILE_STROKES':
        handleCacheTileStrokes(payload);
        break;
      case 'CLEAR_CACHE':
        handleClearCache(id);
        break;
      case 'PREFETCH_TILES':
        await handlePrefetchTiles(payload);
        break;
      default:
        console.warn('[TileWorker] Unknown message type:', type);
    }
  } catch (error) {
    console.error('[TileWorker] Error handling message:', error);
    broadcast({ type: 'ERROR', id, error: error.message });
  }
});

// Handle single tile stroke fetching
async function handleFetchTileStrokes(requestId, { tx, ty, z = 0 }) {
  const tileKey = `${z}:${tx}:${ty}`;
  
  // Check cache first
  if (tileCache.has(tileKey)) {
    const cached = tileCache.get(tileKey);
    broadcast({
      type: 'TILE_STROKES_RESULT',
      id: requestId,
      payload: { tx, ty, z, strokes: cached.strokes, fromCache: true }
    });
    return;
  }
  
  // Check if already fetching
  if (pendingFetches.has(tileKey)) {
    const existingPromise = pendingFetches.get(tileKey);
    try {
      const result = await existingPromise;
      broadcast({
        type: 'TILE_STROKES_RESULT',
        id: requestId,
        payload: { tx, ty, z, strokes: result.strokes, fromCache: false }
      });
    } catch (error) {
      broadcast({
        type: 'TILE_STROKES_RESULT',
        id: requestId,
        payload: { tx, ty, z, strokes: [], error: error.message }
      });
    }
    return;
  }
  
  // Start new fetch with debouncing
  const fetchPromise = debouncedFetch(tileKey, async () => {
    const url = `/api/tile-strokes?z=${z}&tx=${tx}&ty=${ty}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    const strokes = Array.isArray(data.strokes) ? data.strokes : [];
    
    // Cache the result
    cacheStrokes(tileKey, strokes);
    
    return { strokes };
  });
  
  pendingFetches.set(tileKey, fetchPromise);
  
  try {
    const result = await fetchPromise;
    broadcast({
      type: 'TILE_STROKES_RESULT',
      id: requestId,
      payload: { tx, ty, z, strokes: result.strokes, fromCache: false }
    });
  } catch (error) {
    console.error(`[TileWorker] Failed to fetch tile ${tileKey}:`, error);
    broadcast({
      type: 'TILE_STROKES_RESULT',
      id: requestId,
      payload: { tx, ty, z, strokes: [], error: error.message }
    });
  } finally {
    pendingFetches.delete(tileKey);
  }
}

// Handle batch tile stroke fetching
async function handleFetchTileStrokesBatch(requestId, { z = 0, tiles }) {
  // Use the batch endpoint to fetch multiple tiles in one request when possible.
  // This helper will try the bulk endpoint and fall back to per-tile GETs if necessary.
  const tileMap = new Map();
  const tilesToFetch = [];
  const results = [];

  for (const { tx, ty } of tiles) {
    const tileKey = `${z}:${tx}:${ty}`;
    if (tileCache.has(tileKey)) {
      const cached = tileCache.get(tileKey);
      results.push({ tx, ty, strokes: cached.strokes, fromCache: true });
      continue;
    }
    // If a pending fetch exists for this tile, reuse it
    if (pendingFetches.has(tileKey)) {
      tilesToFetch.push({ tx, ty, tileKey, reusePending: true });
      continue;
    }
    tilesToFetch.push({ tx, ty, tileKey, reusePending: false });
    tileMap.set(tileKey, { tx, ty });
  }

  // If nothing to fetch, return cached results immediately
  if (tilesToFetch.length === 0) {
    broadcast({ type: 'TILE_STROKES_BATCH_RESULT', id: requestId, payload: { z, tiles: results } });
    return;
  }

  // Helper to call bulk endpoint with POST JSON { z, tiles: [{tx,ty}, ...] }
  async function fetchTilesBatch(z, tilesList) {
    try {
      const response = await fetch('/api/tile-strokes-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ z, tiles: tilesList })
      });

      if (!response.ok) {
        throw new Error(`Batch HTTP ${response.status}`);
      }

      const data = await response.json();
      // Expecting data.tiles to be an array of { tx, ty, strokes }
      if (Array.isArray(data.tiles)) return data.tiles;

      // Support alternative shape: { tiles: { "z:tx:ty": { strokes: [...] } } }
      if (data.tiles && typeof data.tiles === 'object') {
        const out = [];
        for (const key of Object.keys(data.tiles)) {
          const [tz, ttx, tty] = key.split(':');
          const obj = data.tiles[key] || {};
          out.push({ tx: Number(ttx), ty: Number(tty), strokes: Array.isArray(obj.strokes) ? obj.strokes : [] });
        }
        return out;
      }

      return [];
    } catch (err) {
      // Bubble up error to let caller fallback
      throw err;
    }
  }

  // Chunk the tiles into a reasonable batch size to avoid huge payloads
  const CHUNK = 48;
  const fetchTasks = [];

  for (let i = 0; i < tilesToFetch.length; i += CHUNK) {
    const chunk = tilesToFetch.slice(i, i + CHUNK);
    const tileArgs = chunk.map(t => ({ tx: t.tx, ty: t.ty }));

    // Prepare a batch promise and mark each tile as pending with a per-tile promise
    const batchPromise = (async () => {
      try {
        const batchResult = await fetchTilesBatch(z, tileArgs);
        return { ok: true, tiles: batchResult };
      } catch (err) {
        // On batch failure, fall back to per-tile GET requests
        const fallbacks = await Promise.all(chunk.map(async (t) => {
          try {
            const url = `/api/tile-strokes?z=${z}&tx=${t.tx}&ty=${t.ty}`;
    console.log(`[TileWorker] Prefetching ${tilesToPrefetch.length} tiles around (${centerTx}, ${centerTy})`);
  
    // Simple dedupe: avoid redoing the same prefetch within a short window
    const prefetchKey = `${z}:${centerTx}:${centerTy}:${radius}`;
    if (!self.__recentPrefetches) self.__recentPrefetches = new Map();
    const last = self.__recentPrefetches.get(prefetchKey) || 0;
    const now = Date.now();
    if (now - last < 5 * 1000) {
      // Skip if the same prefetch was performed less than 5s ago
      return;
    }
    self.__recentPrefetches.set(prefetchKey, now);
            if (!resp.ok) return { tx: t.tx, ty: t.ty, strokes: [], error: `HTTP ${resp.status}` };
            const d = await resp.json();
            return { tx: t.tx, ty: t.ty, strokes: Array.isArray(d.strokes) ? d.strokes : [] };
          } catch (e) {
            return { tx: t.tx, ty: t.ty, strokes: [], error: e.message };
          }
        }));
        return { ok: false, tiles: fallbacks };
      }
    })();

    // For each tile in chunk, set pendingFetches to a promise that resolves when batchPromise resolves
    for (const t of chunk) {
      const p = batchPromise.then(res => {
        // Find matching tile in res.tiles
        const found = (res.tiles || []).find(r => Number(r.tx) === Number(t.tx) && Number(r.ty) === Number(t.ty));
        const strokes = Array.isArray(found?.strokes) ? found.strokes : [];
        // Cache strokes
        try { cacheStrokes(t.tileKey || `${z}:${t.tx}:${t.ty}`, strokes); } catch (e) {}
        return { tx: t.tx, ty: t.ty, strokes, fromCache: false, error: found?.error };
      }).catch(err => ({ tx: t.tx, ty: t.ty, strokes: [], error: err?.message || 'batch error' }));

      pendingFetches.set(t.tileKey, p);
    }

    fetchTasks.push(batchPromise);
  }

  // Wait for all batch tasks to finish
  const batchResponses = await Promise.all(fetchTasks.map(p => p.catch(e => ({ ok: false, tiles: [] }))));

  // Collect results from caches and batch responses
  for (const { tx, ty, tileKey } of tilesToFetch) {
    const key = tileKey;
    if (tileCache.has(key)) {
      const cached = tileCache.get(key);
      results.push({ tx, ty, strokes: cached.strokes, fromCache: true });
      // remove pending fetch entry if any
      pendingFetches.delete(key);
      continue;
    }
    // If a pendingFetches promise exists, await it
    if (pendingFetches.has(key)) {
      try {
        const res = await pendingFetches.get(key);
        results.push({ tx, ty, strokes: res.strokes || [], fromCache: false, error: res.error });
      } catch (err) {
        results.push({ tx, ty, strokes: [], error: err?.message || 'fetch error' });
      }
      pendingFetches.delete(key);
      continue;
    }
    // Shouldn't reach here, but provide a safe fallback
    results.push({ tx, ty, strokes: [], error: 'missing' });
  }

  broadcast({ type: 'TILE_STROKES_BATCH_RESULT', id: requestId, payload: { z, tiles: results } });
}

// Handle caching tile strokes from main thread
function handleCacheTileStrokes({ tx, ty, z = 0, strokes }) {
  const tileKey = `${z}:${tx}:${ty}`;
  cacheStrokes(tileKey, strokes);
}

// Handle cache clearing
function handleClearCache(requestId) {
  tileCache.clear();
  pendingFetches.clear();
  
  broadcast({ type: 'CACHE_CLEARED', id: requestId });
}

// Handle prefetching tiles around a viewport
async function handlePrefetchTiles({ centerTx, centerTy, radius = 2, z = 0 }) {
  const tilesToPrefetch = [];
  
  for (let ty = centerTy - radius; ty <= centerTy + radius; ty++) {
    for (let tx = centerTx - radius; tx <= centerTx + radius; tx++) {
      const tileKey = `${z}:${tx}:${ty}`;
      
      // Skip if already cached or being fetched
      if (!tileCache.has(tileKey) && !pendingFetches.has(tileKey)) {
        tilesToPrefetch.push({ tx, ty });
      }
    }
  }
  
  if (tilesToPrefetch.length === 0) {
    return;
  }
  
  console.log(`[TileWorker] Prefetching ${tilesToPrefetch.length} tiles around (${centerTx}, ${centerTy})`);
  // Prefer batch fetching for prefetching to reduce request overhead.
  const CHUNK = 64;
  for (let i = 0; i < tilesToPrefetch.length; i += CHUNK) {
    const chunk = tilesToPrefetch.slice(i, i + CHUNK);
    const tilesList = chunk.map(t => ({ tx: t.tx, ty: t.ty }));
    // Fire-and-forget: try batch endpoint, fallback to individual fetches
    (async () => {
      try {
        const response = await fetch('/api/tile-strokes-batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ z, tiles: tilesList })
        });
        if (!response.ok) throw new Error(`Batch HTTP ${response.status}`);
        const data = await response.json();
        const fetched = Array.isArray(data.tiles) ? data.tiles : [];
        for (const t of fetched) {
          const key = `${z}:${t.tx}:${t.ty}`;
          const strokes = Array.isArray(t.strokes) ? t.strokes : [];
          cacheStrokes(key, strokes);
        }
      } catch (err) {
        // On error, fall back to per-tile fetches so prefetch still happens
        for (const { tx, ty } of chunk) {
          try {
            await handleFetchTileStrokes(null, { tx, ty, z });
          } catch (e) {
            console.warn(`[TileWorker] Prefetch failed for tile ${z}:${tx}:${ty}:`, e);
          }
        }
      }
    })();
  }
}

// Cache strokes with LRU eviction
function cacheStrokes(tileKey, strokes) {
  // Evict oldest entries if cache is full
  if (tileCache.size >= TILE_CACHE_MAX) {
    const keysToDelete = Array.from(tileCache.keys()).slice(0, tileCache.size - TILE_CACHE_MAX + 1);
    keysToDelete.forEach(key => tileCache.delete(key));
  }
  
  tileCache.set(tileKey, {
    strokes: Array.isArray(strokes) ? strokes : [],
    timestamp: Date.now()
  });
}

// Debounced fetch to prevent duplicate requests
const debouncedFetches = new Map();

async function debouncedFetch(key, fetchFn) {
  if (debouncedFetches.has(key)) {
    clearTimeout(debouncedFetches.get(key).timeout);
  }
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      try {
        const result = await fetchFn();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        debouncedFetches.delete(key);
      }
    }, FETCH_DEBOUNCE_MS);
    
    debouncedFetches.set(key, { timeout, resolve, reject });
  });
}

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  
  for (const [key, value] of tileCache.entries()) {
    if (now - value.timestamp > maxAge) {
      tileCache.delete(key);
    }
  }
}, 60 * 1000); // Run every minute

console.log('[TileWorker] Worker loaded and ready');