// Service Worker: proxy /api/tile-strokes-batch to websocket streaming endpoint
// It opens a websocket, sends a tilesRequest, and streams back NDJSON so the page can parse incrementally.

const WS_PATH = '/ws';

self.addEventListener('install', (ev) => { self.skipWaiting(); });
self.addEventListener('activate', (ev) => { ev.waitUntil(self.clients.claim()); });

function makeNdjson(obj) {
  try { return JSON.stringify(obj) + '\n'; } catch { return '' + obj + '\n'; }
}

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (url.pathname === '/api/tile-strokes-batch' && ev.request.method === 'POST') {
    ev.respondWith((async () => {
      try {
        const body = await ev.request.json().catch(() => ({ tiles: [] }));
        const tiles = Array.isArray(body.tiles) ? body.tiles : [];
        const z = Number(body.z ?? 0);

        // Open websocket to same origin
        const proto = self.registration.scope.startsWith('https') ? 'wss:' : 'ws:';
        const wsUrl = (self.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + self.location.host + WS_PATH;

        // Create a readable stream that will be filled by incoming websocket messages
        const rs = new ReadableStream({
          start(controller) {
            let ws;
            let closed = false;
            try {
              ws = new WebSocket(wsUrl);
            } catch (e) {
              controller.error(e);
              return;
            }
            ws.addEventListener('open', () => {
              // Send tilesRequest
              try {
                const reqId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
                ws._reqId = reqId;
                ws.send(JSON.stringify({ type: 'tilesRequest', payload: { reqId, z, tiles } }));
              } catch (e) {}
            });
            ws.addEventListener('message', (ev) => {
              try {
                const msg = JSON.parse(ev.data);
                const { type, payload } = msg || {};
                if (type === 'tileData') {
                  // Push one NDJSON line per tile
                  controller.enqueue(new TextEncoder().encode(makeNdjson(payload)));
                } else if (type === 'tileBatchDone') {
                  if (!closed) { closed = true; controller.close(); try { ws.close(); } catch (e) {} }
                }
              } catch (e) { /* ignore parse errors */ }
            });
            ws.addEventListener('error', (e) => { if (!closed) { closed = true; controller.error(e); try { ws.close(); } catch (e) {} } });
            ws.addEventListener('close', () => { if (!closed) { closed = true; controller.close(); } });
          },
          cancel(reason) {
            // nothing special
          }
        });

        return new Response(rs, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'sw proxy failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    })());
  }
});
