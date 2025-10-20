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
              // Identify as tiles channel (compact) and send compact tilesRequest
              try { ws.send(JSON.stringify([0, 1])); } catch {}
              try {
                const reqId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
                ws._reqId = reqId;
                const tilesArr = Array.isArray(tiles) ? tiles.map(t => [t.tx, t.ty]) : [];
                ws.send(JSON.stringify([3, reqId, z, tilesArr]));
              } catch (e) {}
            });
            ws.addEventListener('message', (ev) => {
              try {
                const msg = JSON.parse(ev.data);
                if (Array.isArray(msg)) {
                  const op = msg[0];
                  if (op === 4) {
                    // [4, reqId, z, tx, ty, compactStrokes]
                    const payload = { reqId: msg[1], z: msg[2], tx: msg[3], ty: msg[4], strokes: (msg[5] || []).map(s => ({ id: s[0], userId: s[1], color: s[2], size: s[3], opacity: s[4], erase: !!s[5], points: (s[6]||[]).reduce((a,c,i)=> { if (i%2===0) a.push({ x: s[6][i], y: s[6][i+1] }); return a; }, []) })) };
                    controller.enqueue(new TextEncoder().encode(makeNdjson(payload)));
                  } else if (op === 6) {
                    if (!closed) { closed = true; controller.close(); try { ws.close(); } catch (e) {} }
                  }
                } else {
                  const { type, payload } = msg || {};
                  if (type === 'tileData') controller.enqueue(new TextEncoder().encode(makeNdjson(payload)));
                  else if (type === 'tileBatchDone') { if (!closed) { closed = true; controller.close(); try { ws.close(); } catch (e) {} } }
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
