// TileManager: spawns multiple dedicated workers to parallelize tile fetching
// Usage:
// const tm = new TileManager({ numWorkers: 4, script: '/tile-worker-thread.js' });
// await tm.init();
// const strokes = await tm.fetchTile(tx, ty, z);
// const batch = await tm.fetchTilesBatch(z, [{tx,ty}, ...]);

export class TileManager {
  constructor({ numWorkers = 4, script = '/tile-worker-thread.js' } = {}) {
    this.numWorkers = numWorkers;
    this.script = script;
    this.workers = [];
    this.nextWorker = 0;
    this._msgId = 0;
    this._pending = new Map(); // id -> {resolve,reject}
    // manager caches to prevent duplicate work
    this.tileCache = new Map(); // tileKey -> strokes[]
    this.tilePending = new Map(); // tileKey -> { promise, resolve, reject }

    // runtime stats and debug
    this.stats = { dedupeHits: 0, requests: 0, inFlight: 0 };
    this.debug = false;
  }

  async init() {
    // spawn dedicated workers
    for (let i = 0; i < this.numWorkers; i++) this._spawnWorker();
  }

  _spawnWorker() {
    const w = new Worker(this.script);
    w.onmessage = (e) => this._handleMessage(e.data, w);
    w.onerror = (err) => console.error('[TileManager] worker error', err);
    this.workers.push(w);
    if (this.debug) console.log('[TileManager] spawned worker, total=', this.workers.length);
    return w;
  }

  _handleMessage(msg, worker) {
    try {
      const { type, id, payload, error } = msg || {};
      if (!id) return; // ignore notifications without id
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (type === 'TILE_STROKES_RESULT') {
        p.resolve(payload.strokes || []);
      } else if (type === 'TILE_STROKES_BATCH_RESULT') {
        p.resolve(payload);
      } else if (type === 'ERROR') {
        p.reject(new Error(error || 'worker error'));
      } else {
        // Unknown: resolve raw payload
        p.resolve(payload);
      }
    } catch (e) {
      console.error('[TileManager] message handling failed', e);
    }
  }

  _postToWorker(worker, type, payload, timeout = 10000) {
    const id = ++this._msgId;
    // instrument requests/inFlight
    this.stats.requests++;
    this.stats.inFlight++;
    if (this.debug) console.log('[TileManager] dispatch', type, payload);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      // timeout
      const t = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          this.stats.inFlight = Math.max(0, this.stats.inFlight - 1);
          reject(new Error('worker request timeout'));
        }
      }, timeout);
      try {
        worker.postMessage({ type, id, payload });
      } catch (err) {
        this._pending.delete(id);
        this.stats.inFlight = Math.max(0, this.stats.inFlight - 1);
        reject(err);
      }
    }).finally(() => {
      this.stats.inFlight = Math.max(0, this.stats.inFlight - 1);
    });
  }

  _getNextWorker() {
    if (!this.workers.length) throw new Error('TileManager not initialized');
    const w = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return w;
  }

  // Fetch a single tile (delegates to a worker)
  async fetchTile(tx, ty, z = 0) {
    const key = `${tx}:${ty}:${z}`;
    // cached
    if (this.tileCache.has(key)) {
      this.stats.dedupeHits++;
      if (this.debug) console.log('[TileManager] cache hit', key);
      return this.tileCache.get(key);
    }
    // in-flight
    const pending = this.tilePending.get(key);
    if (pending) {
      this.stats.dedupeHits++;
      if (this.debug) console.log('[TileManager] dedupe pending', key);
      return pending.promise;
    }

    // create deferred so other callers can reuse
    const d = this._deferred();
    this.tilePending.set(key, d);

    try {
      const w = this._getNextWorker();
      // use worker batch API for a single tile as well (uniform handling)
      const p = this._postToWorker(w, 'FETCH_TILE_STROKES', { tx, ty, z });
      p.then((strokes) => {
        try {
          this.tileCache.set(key, strokes || []);
          const t = this.tilePending.get(key);
          if (t) {
            t.resolve(strokes || []);
            this.tilePending.delete(key);
          }
        } catch (e) {
          if (this.tilePending.get(key)) {
            this.tilePending.get(key).reject(e);
            this.tilePending.delete(key);
          }
        }
      }).catch((err) => {
        const t = this.tilePending.get(key);
        if (t) {
          t.reject(err);
          this.tilePending.delete(key);
        }
      });
      return d.promise;
    } catch (err) {
      // cleanup on immediate failures
      if (this.tilePending.get(key)) {
        this.tilePending.get(key).reject(err);
        this.tilePending.delete(key);
      }
      throw err;
    }
  }

  // Fetch many tiles by splitting the list across workers and merging results
  async fetchTilesBatch(z, tiles = []) {
    if (!tiles || !tiles.length) return { z, tiles: [] };
    // Split tiles into N buckets (simple round-robin chunking)
    const buckets = new Array(this.workers.length).fill(0).map(() => []);
    for (let i = 0; i < tiles.length; i++) {
      buckets[i % buckets.length].push(tiles[i]);
    }

    const promises = [];
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (!bucket.length) continue;
      const w = this.workers[i % this.workers.length];
      promises.push(this._postToWorker(w, 'FETCH_TILE_STROKES_BATCH', { z, tiles: bucket }).catch(err => ({ tiles: [] })));
    }

    const results = await Promise.all(promises);
    // Merge tile arrays
    const merged = [];
    for (const r of results) {
      if (r && r.tiles) merged.push(...r.tiles);
      else if (r && Array.isArray(r)) merged.push(...r);
    }
    return { z, tiles: merged };
  }

  // Prefetch: instruct all workers to prefetch around center (fire-and-forget)
  // Prefetch: compute tile list and distribute fetch work across the pool.
  // This prevents every worker from fetching the same tiles.
  prefetch(centerTx, centerTy, radius = 2, z = 0) {
    try {
      const tiles = [];
      for (let ty = centerTy - radius; ty <= centerTy + radius; ty++) {
        for (let tx = centerTx - radius; tx <= centerTx + radius; tx++) {
          tiles.push({ tx, ty });
        }
      }
      if (!tiles.length) return;
      // Fire-and-forget fetch via existing batch API which will split work
      this.fetchTilesBatch(z, tiles).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  // Dynamically change number of workers (grow/shrink pool)
  setWorkerCount(n) {
    if (!Number.isInteger(n) || n <= 0) return;
    const current = this.workers.length;
    if (n === current) return;
    if (n > current) {
      // spawn additional workers
      for (let i = 0; i < n - current; i++) this._spawnWorker();
    } else {
      // terminate extras
      for (let i = 0; i < current - n; i++) {
        const w = this.workers.pop();
        try { w.terminate(); } catch (e) { /* ignore */ }
      }
    }
    if (this.debug) console.log('[TileManager] setWorkerCount ->', n);
  }

  getStats() {
    return { ...this.stats, workers: this.workers.length };
  }

  dispose() {
    for (const w of this.workers) {
      try { w.terminate(); } catch (e) { /* ignore */ }
    }
    this.workers = [];
  }
}

export default TileManager;
