Infinite Canvas (MVP)

Concept: A shared, boundless drawing universe where everyone draws on the same world in real time.

MVP choices
- Rendering: WebGL final compositing with 2D offscreen tiles.
- Realtime: WebSocket broadcast with `ws`.
- Persistence: SQLite (Bun native) per-tile stroke rows (gzip-compressed JSON).
  - DB file: `data/tiles.sqlite3`
  - Table: `tile_strokes (z, tx, ty, t, id, json BLOB)` with index on `(z, tx, ty, t)`
  - Compression: gzip level 9 by default; override with `DB_GZIP_LEVEL`
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
