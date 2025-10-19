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
  const results = [];
  const fetchPromises = [];
  
  for (const { tx, ty } of tiles) {
    const tileKey = `${z}:${tx}:${ty}`;
    
    // Check cache first
    if (tileCache.has(tileKey)) {
      const cached = tileCache.get(tileKey);
      results.push({
        tx,
        ty,
        strokes: cached.strokes,
        fromCache: true
      });
      continue;
    }
    
    // Add to fetch queue
    const fetchPromise = (async () => {
      try {
        const url = `/api/tile-strokes?z=${z}&tx=${tx}&ty=${ty}`;
        const response = await fetch(url);
        
        if (!response.ok) {
          console.warn(`[TileWorker] Failed to fetch tile ${tileKey}: HTTP ${response.status}`);
          return { tx, ty, strokes: [], error: `HTTP ${response.status}` };
        }
        
        const data = await response.json();
        const strokes = Array.isArray(data.strokes) ? data.strokes : [];
        
        // Cache the result
        cacheStrokes(tileKey, strokes);
        
        return { tx, ty, strokes, fromCache: false };
      } catch (error) {
        console.error(`[TileWorker] Error fetching tile ${tileKey}:`, error);
        return { tx, ty, strokes: [], error: error.message };
      }
    })();
    
    fetchPromises.push(fetchPromise);
  }
  
  // Wait for all fetches to complete
  const fetchResults = await Promise.all(fetchPromises);
  results.push(...fetchResults);
  
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
  
  // Fetch tiles in background without blocking
  const prefetchPromises = tilesToPrefetch.map(async ({ tx, ty }) => {
    try {
      await handleFetchTileStrokes(null, { tx, ty, z });
    } catch (error) {
      console.warn(`[TileWorker] Prefetch failed for tile ${z}:${tx}:${ty}:`, error);
    }
  });
  
  // Don't wait for completion, let them run in background
  Promise.all(prefetchPromises).catch(() => {
    // Ignore prefetch errors
  });
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

console.log('[TileWorker] Service worker loaded and ready');