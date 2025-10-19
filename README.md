Infinite Canvas (MVP)

Concept: A shared, boundless drawing universe where everyone draws on the same world in real time.

MVP choices
- Rendering: Canvas2D, tile-based offscreen caches (no external frontend deps).
- Realtime: WebSocket broadcast with `ws`.
- Persistence: Stroke logs per tile as NDJSON (append-only) with optional gzip snapshots.
  - Hot writes append to `data/tiles/<z>/<tx>_<ty>.ndjson` for reliability.
  - If a `.ndjson.gz` exists, it is also supported on reads; raw `.ndjson` takes precedence.
  - A compactor can be added to gzip/rotate old data if needed.
- Coordinates: World pixels with origin at (0,0). URL query: `?x=&y=&z=`.
- Tile size: 1024 px. Zoom is continuous, single resolution for now.

Prereqs
- Bun >= 1.0 (https://bun.sh)

Install and run
```bash
bun install # optional, no deps required
bun --watch server/index.js
# then open http://localhost:3000
```

Run tests
```bash
bun test
```

Project structure
- `client/` static files served by the server (HTML/CSS/JS)
- `server/` Node HTTP + WebSocket server
- `data/` tile stroke logs (created at runtime)

Notes
- This MVP persists vector stroke events per tile. It avoids native image tooling.
- A PNG tile snapshot pipeline can be added later (server-side compositor).
- Concurrency: multiple users’ strokes are broadcast in realtime and also appended to per-tile logs.
