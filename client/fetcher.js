// Worker that performs network fetching and JSON parsing off the main thread.
// Supports two messages:
// { type: 'fetchTile', id, tx, ty, z }
//   -> posts { type: 'tileResult', id, tx, ty, z, strokes }
// { type: 'batchFetch', id, z, tiles }
//   -> posts { type: 'batchResult', id, tiles }

const q = new Map(); // debounce map key -> { timer, callers: [id,...] }

function tileKey(tx, ty, z) { return `${z}:${tx}:${ty}`; }

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  const { type } = msg;
  if (type === 'fetchTile') {
    const { id, tx, ty, z = 0 } = msg;
    const k = tileKey(tx, ty, z);
    let entry = q.get(k);
    if (!entry) {
      entry = { callers: [], timer: null };
      q.set(k, entry);
      // debounce similar to main thread (200ms)
      entry.timer = setTimeout(async () => {
        q.delete(k);
        try {
          const url = `/api/tile-strokes?z=${z}&tx=${tx}&ty=${ty}`;
          const res = await fetch(url);
          if (!res.ok) {
            // reply empty arrays for all callers
            for (const cid of entry.callers) self.postMessage({ type: 'tileResult', id: cid, tx, ty, z, strokes: [] });
            return;
          }
          const json = await res.json().catch(() => ({}));
          const strokes = Array.isArray(json?.strokes) ? json.strokes : (json?.strokes ? json.strokes : []);
          for (const cid of entry.callers) self.postMessage({ type: 'tileResult', id: cid, tx, ty, z, strokes });
        } catch (e) {
          for (const cid of entry.callers) self.postMessage({ type: 'tileResult', id: cid, tx, ty, z, strokes: [] });
        }
      }, 200);
    }
    entry.callers.push(id);
    return;
  }

  if (type === 'batchFetch') {
    const { id, z = 0, tiles } = msg;
    (async () => {
      try {
        const res = await fetch('/api/tile-strokes-batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ z, tiles })
        });
        if (!res.ok) {
          self.postMessage({ type: 'batchResult', id, tiles: [] });
          return;
        }
        const json = await res.json().catch(() => ({}));
        const out = Array.isArray(json?.tiles) ? json.tiles : [];
        self.postMessage({ type: 'batchResult', id, tiles: out });
      } catch (e) {
        self.postMessage({ type: 'batchResult', id, tiles: [] });
      }
    })();
    return;
  }
});
