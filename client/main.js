const TILE_SIZE = window.__CONFIG__?.TILE_SIZE || 1024;
// Debug: enable with ?debug=1 or localStorage.setItem('debug','1')
const DEBUG = /(?:[?&])debug=1(?:&|$)/.test(location.search) || localStorage.getItem('debug') === '1';
function dlog(...args) { if (DEBUG) console.log('[IC]', ...args); }
// Extra offscreen pixels around each tile to avoid seam clipping
const TILE_PAD = 128; // should be >= max brush size
// Limit maximum zoom-out to reduce tile load
const MIN_SCALE = 0.10;
const MAX_SCALE = 4;
const STATE = { dpr: window.devicePixelRatio || 1, showGrid: true };
const TILE_CACHE_MAX = 256; // allow more tiles in memory while bounded

const canvas = document.getElementById('canvas');
const overlay = document.getElementById('overlay');
const toolbarEl = document.querySelector('.toolbar');
import { WebGLRenderer } from './webgl.js';
// Fetcher worker runs network fetches off the main thread
let fetchWorker = null;
const _workerPending = new Map(); // id -> {resolve, reject, type}
// Local batch queue to coalesce per-tile requests into one batch
const _tileBatchQueue = new Map(); // key -> {tx,ty,z, resolvers: [{resolve,reject}, ...]}
let _tileBatchTimer = null;
function ensureWorker() {
  if (fetchWorker) return fetchWorker;
  try {
    fetchWorker = new Worker(new URL('./fetcher.js', import.meta.url));
    dlog('Fetch worker created');
    fetchWorker.addEventListener('error', (err) => {
      dlog('Fetch worker error, disabling worker fallback', err && err.message);
      try { fetchWorker.terminate(); } catch {}
      fetchWorker = null;
    });
  } catch (e) {
    // fallback: worker unsupported, keep null and main thread will fetch
    fetchWorker = null;
    return null;
  }
  fetchWorker.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    const { type } = msg;
    if (type === 'tileResult') {
      const { id, tx, ty, z, strokes } = msg;
      const p = _workerPending.get(id);
      if (p) { p.resolve(Array.isArray(strokes) ? strokes : []); _workerPending.delete(id); }
    } else if (type === 'batchResult') {
      const { id, tiles } = msg;
      const p = _workerPending.get(id);
      if (p) { p.resolve(tiles || []); _workerPending.delete(id); }
    } else if (type === 'batchTile') {
      // Incremental tile pushed from worker while streaming NDJSON
      const { id: reqId, tile } = msg;
      if (!tile) return;
      try {
        const z = Number(tile.z || 0);
        const tx = Number(tile.tx);
        const ty = Number(tile.ty);
        const arr = Array.isArray(tile.strokes) ? tile.strokes : [];
        // Persist authoritative list in LS (synchronously so immediate reads see it)
        try { lsSaveTileStrokesSync(z, tx, ty, arr); } catch (e) {}
        const key = tileKey(tx, ty, z);
        const t = tiles.get(key);
        if (t) {
          // Reset and draw strictly from LS to avoid partial duplication
          resetTile(t);
          const cached = lsLoadTileStrokes(z, tx, ty) || [];
          for (const s of cached) { if (s && s.id && !t.seen.has(s.id)) { drawStrokeOnTile(t, s); t.seen.add(s.id); t.cached.push(s); } }
          t.dirty = true;
          requestFrame();
        }
      } catch (e) { /* ignore incremental tile errors */ }
    }
  });
  return fetchWorker;
}
const renderer = new WebGLRenderer(canvas);
const octx = overlay.getContext('2d');

// UI elements
const toolPanBtn = document.getElementById('tool-pan');
const toolPenBtn = document.getElementById('tool-pen');
const toolEraserBtn = document.getElementById('tool-eraser');
const colorInput = document.getElementById('color');
const sizeInput = document.getElementById('size');
const opacityInput = document.getElementById('opacity');
const gridToggle = document.getElementById('toggle-grid');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const exportSvgBtn = document.getElementById('export-svg');

// View transform (world -> screen)
const view = {
  scale: 1,
  tx: 0, // translate x (screen pixels)
  ty: 0, // translate y (screen pixels)
};

// State
let tool = 'pen'; // 'pen' | 'eraser' | 'pan'
let isPanning = false;
let isDrawing = false;
let spaceHeld = false;
let pointerId = null;
let lastPointer = null; // {x,y}
let activeStroke = null; // {points, color, size, opacity, erase}
let myId = null;
// Initialize color from persisted preference or input default
const savedColor = localStorage.getItem('color');
if (savedColor) {
  try { colorInput.value = savedColor; } catch {}
}
let myColor = colorInput.value;

// Restore size/opacity/tool from storage
const savedSize = localStorage.getItem('size');
if (savedSize) {
  const n = Math.max(2, Math.min(128, Number(savedSize)));
  if (Number.isFinite(n)) sizeInput.value = String(n);
}
const savedOpacity = localStorage.getItem('opacity');
if (savedOpacity) {
  const n = Math.max(0.1, Math.min(1, Number(savedOpacity)));
  if (Number.isFinite(n)) opacityInput.value = String(n);
}
const initialTool = (['eraser','pan'].includes(localStorage.getItem('tool'))) ? localStorage.getItem('tool') : 'pen';
let myName = null;
// Persisted peer/session identity
const LS_SESSION_ID = 'ic_session_id_v1';
const LS_SESSION_NAME = 'ic_session_name_v1';
try {
  const n = localStorage.getItem(LS_SESSION_NAME);
  if (n) myName = n;
} catch {}
let ws = null;
let wsReady = false;

// Presence: id -> {x,y,color,name}
const peers = new Map();

// Tile cache: key -> {canvas, ctx, dirty}
const tiles = new Map();
// LocalStorage tile cache (strokes) to reduce memory pressure
const LS_TILE_PREFIX = 'ic_tile_strokes_v1:'; // ic_tile_strokes_v1:z:tx:ty
const LS_INDEX_KEY = 'ic_tile_index_v1';
const LS_BUDGET_BYTES = 4 * 1024 * 1024; // ~4MB budget

function lsIndexLoad() {
  try { return JSON.parse(localStorage.getItem(LS_INDEX_KEY) || '{}') || {}; } catch { return {}; }
}
function lsIndexSave(idx) {
  try { localStorage.setItem(LS_INDEX_KEY, JSON.stringify(idx)); } catch {}
}
function lsTileKey(z, tx, ty) { return `${LS_TILE_PREFIX}${z}:${tx}:${ty}`; }
function lsEstimateBytes(str) { return str ? str.length : 0; }
function lsPrune(budget) {
  try {
    const idx = lsIndexLoad();
    const entries = Object.entries(idx);
    let total = entries.reduce((s, [, v]) => s + (v.bytes || 0), 0);
    if (total <= budget) return;
    entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    for (const [k, v] of entries) {
      if (total <= budget) break;
      localStorage.removeItem(k);
      total -= v.bytes || 0;
      delete idx[k];
    }
    lsIndexSave(idx);
  } catch {}
}
function lsSaveTileStrokes(z, tx, ty, arr) {
  try {
    const key = lsTileKey(z, tx, ty);
    const json = JSON.stringify(arr || []);
    const idx = lsIndexLoad();
    // Defer actual localStorage writes so they don't block the main flow
    setTimeout(() => {
      try {
        localStorage.setItem(key, json);
        idx[key] = { ts: Date.now(), bytes: lsEstimateBytes(json) };
        lsIndexSave(idx);
        lsPrune(LS_BUDGET_BYTES);
      } catch (e) { /* ignore storage errors */ }
    }, 0);
  } catch {}
}

// Synchronous variant used when code needs to read immediately after writing.
function lsSaveTileStrokesSync(z, tx, ty, arr) {
  try {
    const key = lsTileKey(z, tx, ty);
    const json = JSON.stringify(arr || []);
    try {
      localStorage.setItem(key, json);
    } catch (e) { /* swallow */ }
    try {
      const idx = lsIndexLoad();
      idx[key] = { ts: Date.now(), bytes: lsEstimateBytes(json) };
      lsIndexSave(idx);
      lsPrune(LS_BUDGET_BYTES);
    } catch (e) { /* swallow */ }
  } catch (e) { /* ignore */ }
}
function lsLoadTileStrokes(z, tx, ty) {
  try {
    const key = lsTileKey(z, tx, ty);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    const idx = lsIndexLoad();
    if (idx[key]) { idx[key].ts = Date.now(); lsIndexSave(idx); }
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
let frameCounter = 0;
const NEW_TILE_BUDGET = 256; // tiles can stream in faster per frame
let newTilesThisFrame = 0;

function tileKey(tx, ty, z = 0) { return `${z}:${tx}:${ty}`; }

function tryGetTile(tx, ty, z = 0) {
  const key = tileKey(tx, ty, z);
  let t = tiles.get(key);
  if (!t) {
    if (newTilesThisFrame >= NEW_TILE_BUDGET) return null;
    const c = document.createElement('canvas');
    c.width = TILE_SIZE + TILE_PAD * 2; c.height = TILE_SIZE + TILE_PAD * 2;
    const tctx = c.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    t = { key, tx, ty, z, pad: TILE_PAD, canvas: c, ctx: tctx, loaded: false, layers: new Map(), dirty: false, lastUsed: 0, seen: new Set(), cached: [] };
    tiles.set(key, t);
    newTilesThisFrame++;
    // Restore from localStorage first
    const cached = lsLoadTileStrokes(z, tx, ty);
    if (cached && cached.length) {
      dlog('LS restore', { tile: key, strokes: cached.length });
      for (const s of cached) { if (s && s.id && !t.seen.has(s.id)) { drawStrokeOnTile(t, s); t.seen.add(s.id); t.cached.push(s); } }
      t.loaded = true;
    }
    // Then lazy load strokes from server and merge only new ones
    loadTileStrokes(tx, ty, z).then(strokes => {
      dlog('HTTP restore result', { tile: key, strokes: (strokes||[]).length });
      let added = 0;
      for (const s of strokes) {
        if (!s || !s.id || t.seen.has(s.id)) continue;
        t.seen.add(s.id);
        t.cached.push(s);
        added++;
      }
      if (added > 0) {
        // Persist authoritative list first (sync so subsequent LS reads see data)
        try { lsSaveTileStrokesSync(z, tx, ty, t.cached); } catch (e) {}
        // Rehydrate strictly from LS, then render from LS
        const fresh = lsLoadTileStrokes(z, tx, ty) || [];
        resetTile(t);
        for (const s of fresh) { if (s && s.id) { drawStrokeOnTile(t, s); t.seen.add(s.id); } }
        t.cached = fresh;
        t.dirty = true;
      }
      t.loaded = true; requestFrame();
    }).catch(() => {});
  }
  t.lastUsed = frameCounter;
  return t;
}

// Reset a tile's composited content and per-user layers
function resetTile(tile) {
  try { tile.layers = new Map(); } catch {}
  try { tile.seen = new Set(); } catch {}
  try {
    const tctx = tile.ctx;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);
  } catch {}
  tile.cached = [];
  tile.dirty = true;
  dlog('Tile reset', tile.key);
}

function destroyTile(t) {
  try {
    for (const [, layer] of t.layers || []) {
      try { layer.canvas.width = 0; layer.canvas.height = 0; } catch {}
    }
  } catch {}
  if (renderer && renderer.ok()) { try { renderer.disposeTile(t); } catch {} }
  if (t.canvas) { try { t.canvas.width = 0; t.canvas.height = 0; } catch {} }
}

function evictTiles(centerTx, centerTy) {
  if (tiles.size <= TILE_CACHE_MAX) return;
  const arr = Array.from(tiles.values());
  arr.sort((a, b) => {
    if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
    const da = Math.hypot(a.tx - centerTx, a.ty - centerTy);
    const db = Math.hypot(b.tx - centerTx, b.ty - centerTy);
    return db - da; // prefer evicting farther ones
  });
  let toRemove = tiles.size - TILE_CACHE_MAX;
  for (let i = 0; i < arr.length && toRemove > 0; i++) {
    const t = arr[i];
    tiles.delete(t.key);
    destroyTile(t);
    toRemove--;
  }
}

function getTileLayer(tile, userId) {
  const id = String(userId || '');
  let layer = tile.layers.get(id);
  if (!layer) {
    const c = document.createElement('canvas');
    c.width = tile.canvas.width; c.height = tile.canvas.height;
    const ctx = c.getContext('2d');
    layer = { id, canvas: c, ctx };
    tile.layers.set(id, layer);
    tile.dirty = true;
  }
  return layer;
}

function compositeTile(tile) {
  if (!tile.dirty) return;
  const tctx = tile.ctx;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);
  for (const [, layer] of tile.layers) {
    tctx.globalCompositeOperation = 'source-over';
    tctx.drawImage(layer.canvas, 0, 0);
  }
  tile.dirty = false;
  // Mark GL texture for upload on next draw
  tile.glDirty = true;
}

function worldToScreen(x, y) { return { x: x * view.scale + view.tx, y: y * view.scale + view.ty }; }
function screenToWorld(x, y) { return { x: (x - view.tx) / view.scale, y: (y - view.ty) / view.scale }; }

function updateUiOffsetVar() {
  try {
    if (!toolbarEl) return;
    const rect = toolbarEl.getBoundingClientRect();
    const offset = Math.max(0, Math.ceil(rect.bottom));
    document.documentElement.style.setProperty('--ui-offset', offset + 'px');
  } catch {}
}

function resize() {
  // Update stage top offset for small screens before measuring canvas size
  updateUiOffsetVar();
  const dpr = window.devicePixelRatio || 1;
  STATE.dpr = dpr;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  overlay.style.width = w + 'px';
  overlay.style.height = h + 'px';
  if (renderer && renderer.ok()) renderer.resize(canvas.width, canvas.height);
  requestFrame();
}

window.addEventListener('resize', resize);
// Improve mobile behavior: react to dynamic viewport changes (iOS URL bar, etc.)
try {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize);
    window.visualViewport.addEventListener('scroll', resize);
  }
} catch {}

// Zoom around a screen point
function zoomAt(screenX, screenY, deltaScale) {
  const before = screenToWorld(screenX, screenY);
  view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * deltaScale));
  // Keep the point under the cursor fixed after zoom
  view.tx = screenX - before.x * view.scale;
  view.ty = screenY - before.y * view.scale;
  updateUrlFromView();
  requestFrame();
}

function zoomToCenter(deltaScale) {
  const dpr = STATE.dpr;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  zoomAt(cssW / 2, cssH / 2, deltaScale);
}

// Determine visible tiles for current view
function visibleTilesList() {
  const dpr = STATE.dpr;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const a = screenToWorld(0, 0);
  const b = screenToWorld(cssW, cssH);
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x, b.x);
  const maxY = Math.max(a.y, b.y);
  // Use an epsilon so a boundary that lies exactly on a tile edge
  // doesn't include the next tile that starts there.
  const eps = 1e-6;
  const tx0 = Math.floor(minX / TILE_SIZE);
  const ty0 = Math.floor(minY / TILE_SIZE);
  const tx1 = Math.floor((maxX - eps) / TILE_SIZE);
  const ty1 = Math.floor((maxY - eps) / TILE_SIZE);
  const out = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      out.push({ tx, ty });
    }
  }
  return out;
}

// Determine visible tile range and draw them
function draw() {
  frameCounter++;
  newTilesThisFrame = 0; // reset per frame so tiles can stream in progressively
  const dpr = STATE.dpr;
  // Clear via WebGL and set view
  if (renderer && renderer.ok()) {
    renderer.setView(view.scale, view.tx, view.ty, dpr);
    renderer.begin(true);
  }

  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;

  // Background checker/grid
  if (STATE.showGrid) drawBackgroundGrid(cssW, cssH);

  // Visible tiles with guard for extreme zooms
  const vis = visibleTilesList();
  // Cap tiles rendered at extreme zoom-out (lowered for stability)
  const MAX_TILES = 1600; // up to ~40x40 tiles
  if (vis.length > 0 && vis.length <= MAX_TILES) {
    for (const { tx, ty } of vis) {
      const t = tryGetTile(tx, ty);
      if (!t) continue;
      compositeTile(t);
      const wx = tx * TILE_SIZE;
      const wy = ty * TILE_SIZE;
      // draw only the inner tile area (crop out padding)
      if (renderer && renderer.ok()) {
        // Draw border first so it appears underneath content (like destination-over)
        if (STATE.showGrid) renderer.drawRectOutline(wx, wy, TILE_SIZE, TILE_SIZE, 1 / view.scale, [1, 1, 1, 0.05]);
        renderer.drawTile(t, wx, wy, TILE_SIZE, TILE_SIZE);
      }
    }
  } else {
    // Too many tiles: render a subset around center so strokes remain visible
    const centerWorld = screenToWorld(cssW / 2, cssH / 2);
    const tcx = Math.floor(centerWorld.x / TILE_SIZE);
    const tcy = Math.floor(centerWorld.y / TILE_SIZE);
    const side = Math.max(1, Math.floor(Math.sqrt(MAX_TILES)));
    const half = Math.floor(side / 2);
    const minTx = tcx - half, maxTx = tcx + half;
    const minTy = tcy - half, maxTy = tcy + half;
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const t = tryGetTile(tx, ty);
        if (!t) continue;
        compositeTile(t);
        const wx = tx * TILE_SIZE;
        const wy = ty * TILE_SIZE;
        if (renderer && renderer.ok()) {
          if (STATE.showGrid) renderer.drawRectOutline(wx, wy, TILE_SIZE, TILE_SIZE, 1 / view.scale, [1, 1, 1, 0.05]);
          renderer.drawTile(t, wx, wy, TILE_SIZE, TILE_SIZE);
        }
      }
    }
    // Flag to show subset hint in overlay to match original visuals
    STATE._subsetHint = true;
  }

  // Evict far-away/old tiles to bound memory
  const centerWorld2 = screenToWorld(cssW / 2, cssH / 2);
  evictTiles(Math.floor(centerWorld2.x / TILE_SIZE), Math.floor(centerWorld2.y / TILE_SIZE));

  // Overlay: cursors and in-progress stroke
  drawOverlay();
}

function drawBackgroundGrid(w, h) {
  if (!(renderer && renderer.ok())) return;
  const spacing = TILE_SIZE;
  const min = screenToWorld(0, 0);
  const max = screenToWorld(w, h);
  const thickness = 1 / view.scale; // 1px in screen space
  renderer.drawGrid(min.x, min.y, max.x, max.y, spacing, thickness, [1, 1, 1, 0.03]);
}

function drawOverlay() {
  const dpr = STATE.dpr;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // In-progress stroke preview (smoothed)
  if (activeStroke && activeStroke.points.length > 0) {
    octx.save();
    octx.globalAlpha = activeStroke.opacity;
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    octx.lineWidth = activeStroke.size * view.scale;
    octx.strokeStyle = activeStroke.erase ? 'rgba(0,0,0,1)' : activeStroke.color;
    if (activeStroke.erase) octx.globalCompositeOperation = 'destination-out';
    const pts = activeStroke.points.map(p => worldToScreen(p.x, p.y));
    if (pts.length === 1) {
      const r = (activeStroke.size * view.scale) / 2;
      const c = pts[0];
      octx.beginPath();
      octx.arc(c.x, c.y, r, 0, Math.PI * 2);
      // Use fill for single-point to create a round dab
      octx.fillStyle = activeStroke.erase ? 'rgba(0,0,0,1)' : activeStroke.color;
      octx.fill();
    } else {
      drawSmoothPath2D(octx, pts);
      octx.stroke();
    }
    octx.restore();
  }

  // Remote cursors
  for (const [id, p] of peers) {
    const s = worldToScreen(p.x || 0, p.y || 0);
    octx.save();
    octx.fillStyle = p.color || '#fff';
    octx.strokeStyle = 'rgba(0,0,0,0.5)';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    octx.fill();
    octx.stroke();
    octx.fillStyle = 'rgba(255,255,255,0.9)';
    octx.font = '12px system-ui, -apple-system, Segoe UI';
    octx.fillText(p.name || id, s.x + 10, s.y - 10);
    octx.restore();
  }
  // Subset hint text when too many tiles are shown
  if (STATE._subsetHint) {
    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.fillStyle = 'rgba(255,255,255,0.8)';
    octx.font = '14px system-ui, -apple-system, Segoe UI';
    octx.fillText('Showing subset — zoom in for full detail', 16, 48);
    octx.restore();
    STATE._subsetHint = false;
  }
}

let raf = null;
function requestFrame() { if (!raf) raf = requestAnimationFrame(() => { raf = null; draw(); }); }

// Tile stroke compositing
function drawStrokeOnTile(tile, stroke) {
  const layer = getTileLayer(tile, stroke.userId || '');
  const tctx = layer.ctx;
  tctx.save();
  // Move world coords into tile-local coords
  tctx.setTransform(1, 0, 0, 1, -tile.tx * TILE_SIZE + tile.pad, -tile.ty * TILE_SIZE + tile.pad);
  tctx.globalAlpha = stroke.opacity ?? 1;
  tctx.lineCap = 'round';
  tctx.lineJoin = 'round';
  tctx.lineWidth = Number(stroke.size) || 4;
  const erase = Boolean(stroke.erase);
  tctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  tctx.strokeStyle = stroke.color || '#000';
  const pts = stroke.points || [];
  if (pts.length === 1) {
    const p = pts[0];
    const r = (Number(stroke.size) || 4) / 2;
    tctx.beginPath();
    tctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    // Fill to create a round dab for single-point strokes
    tctx.fillStyle = stroke.color || '#000';
    tctx.fill();
  } else if (pts.length > 1) {
    drawSmoothPath2D(tctx, pts);
    tctx.stroke();
  }
  tctx.restore();
  tile.dirty = true;
}

// Draw a smoothed path using quadratic curves through midpoints
function drawSmoothPath2D(ctx, pts) {
  if (!Array.isArray(pts) || pts.length === 0) return;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[0].x, pts[0].y);
    return;
  }
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    const mx = (p.x + next.x) / 2;
    const my = (p.y + next.y) / 2;
    ctx.quadraticCurveTo(p.x, p.y, mx, my);
  }
  // last segment
  const pPrev = pts[pts.length - 2];
  const pLast = pts[pts.length - 1];
  ctx.quadraticCurveTo(pPrev.x, pPrev.y, pLast.x, pLast.y);
}

function applyLiveEraserSegment(stroke, p0, p1) {
  if (!stroke || !stroke.erase) return;
  const seg = {
    id: stroke.id,
    userId: stroke.userId,
    color: stroke.color,
    size: stroke.size,
    opacity: stroke.opacity,
    erase: true,
    points: [p0, p1]
  };
  const tilesTouched = tilesForStroke(seg);
  for (const { tx, ty } of tilesTouched) {
    const t = tryGetTile(tx, ty);
    if (!t) continue;
    drawStrokeOnTile(t, seg);
  }
}

function tilesForStroke(stroke) {
  const pts = stroke.points || [];
  if (pts.length === 0) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  const pad = (stroke.size || 4) * 2;
  const tx0 = Math.floor((minX - pad) / TILE_SIZE);
  const ty0 = Math.floor((minY - pad) / TILE_SIZE);
  const tx1 = Math.floor((maxX + pad) / TILE_SIZE);
  const ty1 = Math.floor((maxY + pad) / TILE_SIZE);
  const list = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) list.push({ tx, ty });
  return list;
}

// Networking
async function loadTileStrokes(tx, ty, z = 0) {
  // Coalesce many per-tile calls into a single batch fetch to reduce RPCs
  const worker = ensureWorker();
  if (!worker) {
    // fallback: direct HTTP request for this single tile
    try {
      const resp = await fetch(`/api/tile-strokes?z=${encodeURIComponent(z)}&tx=${encodeURIComponent(tx)}&ty=${encodeURIComponent(ty)}`);
      if (!resp.ok) return [];
      const json = await resp.json().catch(() => null);
      if (!json || !Array.isArray(json.strokes)) return [];
      return json.strokes;
    } catch (e) { return []; }
  }
  const key = `${z}:${tx}:${ty}`;
  let entry = _tileBatchQueue.get(key);
  if (!entry) {
    entry = { tx, ty, z, resolvers: [] };
    _tileBatchQueue.set(key, entry);
  }
  const p = new Promise((resolve, reject) => { entry.resolvers.push({ resolve, reject }); });

  // debounce flush
  if (!_tileBatchTimer) {
    _tileBatchTimer = setTimeout(() => {
      _tileBatchTimer = null;
      const items = Array.from(_tileBatchQueue.values());
      _tileBatchQueue.clear();
      const tilesList = items.map(it => ({ tx: it.tx, ty: it.ty }));
      const reqId = cryptoId();
      // store a pending that will distribute results to per-tile resolvers
      _workerPending.set(reqId, {
        resolve: (tilesResp) => {
          try {
            const map = new Map();
            for (const t of tilesResp || []) {
              const k = `${t.z || 0}:${t.tx}:${t.ty}`;
              map.set(k, t);
            }
            for (const it of items) {
              const k = `${it.z || 0}:${it.tx}:${it.ty}`;
              const tileObj = map.get(k);
              const strokes = tileObj && Array.isArray(tileObj.strokes) ? tileObj.strokes : [];
              for (const r of it.resolvers) {
                try { r.resolve(strokes); } catch (e) {}
              }
            }
          } catch (e) {
            for (const it of items) for (const r of it.resolvers) try { r.resolve([]); } catch (e) {}
          } finally { _workerPending.delete(reqId); }
        },
        reject: () => { for (const it of items) for (const r of it.resolvers) try { r.resolve([]); } catch (e) {} },
        type: 'batch'
      });
      try {
        worker.postMessage({ type: 'batchFetch', id: reqId, z: 0, tiles: tilesList });
      } catch (e) {
        for (const it of items) for (const r of it.resolvers) try { r.resolve([]); } catch (e) {}
        _workerPending.delete(reqId);
      }
    }, 40);
  }
  return p;
}

// Initial one-shot batch fetch for all visible tiles to quickly restore from server
function visibleTileBounds() {
  const dpr = STATE.dpr;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cssW, cssH);
  const minX = Math.min(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxX = Math.max(tl.x, br.x);
  const maxY = Math.max(tl.y, br.y);
  const eps = 1e-6;
  const tx0 = Math.floor(minX / TILE_SIZE);
  const ty0 = Math.floor(minY / TILE_SIZE);
  const tx1 = Math.floor((maxX - eps) / TILE_SIZE);
  const ty1 = Math.floor((maxY - eps) / TILE_SIZE);
  return { tx0, ty0, tx1, ty1 };
}

async function batchFetchVisibleOnce() {
  // Use same logic as draw()
  const tilesList = visibleTilesList();
  if (tilesList.length === 0) return;
  try {
    const z = 0;
    dlog('Batch restore start', { count: tilesList.length, bounds: { tx0, ty0, tx1, ty1 } });
    // Use fetchTilesBatch which handles worker + HTTP fallback
    const tilesResp = await fetchTilesBatch(tilesList, z);
    for (const t of tilesResp || []) {
      const arr = Array.isArray(t.strokes) ? t.strokes : [];
      // Persist authoritative list in LS for this tile (sync so immediate reads see it)
      lsSaveTileStrokesSync(z, t.tx, t.ty, arr);
      // If we already have the tile object, reset and draw strictly from LS
      const key = tileKey(t.tx, t.ty, z);
      const tile = tiles.get(key);
      if (tile) {
        resetTile(tile);
        const cached = lsLoadTileStrokes(z, t.tx, t.ty) || [];
        for (const s of cached) { if (s && s.id) { drawStrokeOnTile(tile, s); tile.seen.add(s.id); tile.cached.push(s); } }
        tile.dirty = true;
      }
      dlog('Batch tile applied', { tile: key, strokes: arr.length });
    }
    dlog('Batch restore done');
    requestFrame();
  } catch (e) {
    // Fall back: per-tile lazy fetch will still occur
    dlog('Batch restore unavailable; falling back to per-tile', e?.message || e);
  }
}
// Fetch a batch of tiles (via worker if available, otherwise HTTP)
async function fetchTilesBatch(tilesList, z = 0) {
  if (!Array.isArray(tilesList) || tilesList.length === 0) return [];
  const worker = ensureWorker();
  if (!worker) return [];
  const reqId = cryptoId();
  return await new Promise((resolve) => {
    _workerPending.set(reqId, { resolve, reject: () => {}, type: 'batch' });
    try { worker.postMessage({ type: 'batchFetch', id: reqId, z, tiles: tilesList }); } catch (e) { _workerPending.delete(reqId); resolve([]); }
  });
}

// HTTP fallback that posts to server batch endpoint if worker is unavailable
async function fetchTilesBatchHttp(tilesList, z = 0) {
  try {
    const resp = await fetch('/api/tile-strokes-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ z, tiles: tilesList }) });
    if (!resp.ok) return [];
    const json = await resp.json().catch(() => null);
    if (!json || !Array.isArray(json.tiles)) return [];
    return json.tiles.map(t => ({ z: Number(t.z || 0), tx: Number(t.tx), ty: Number(t.ty), strokes: Array.isArray(t.strokes) ? t.strokes : [] }));
  } catch (e) { return []; }
}

// Updated fetchTilesBatch to use HTTP fallback when worker is not available or times out
async function fetchTilesBatchWithFallback(tilesList, z = 0) {
  const worker = ensureWorker();
  if (worker) {
    try {
      const res = await fetchTilesBatch(tilesList, z);
      if (Array.isArray(res) && res.length > 0) return res;
      // fallthrough to HTTP fallback
    } catch (e) { /* continue to HTTP fallback */ }
  }
  return await fetchTilesBatchHttp(tilesList, z);
}

// Populate/validate localStorage for all visible tiles using chunked batch requests
async function populateVisibleFromServer() {
  const z = 0;
  // Use the same robust visibility used for drawing
  const tilesList = visibleTilesList();
  if (tilesList.length === 0) return;
  dlog('Populate LS: batches', { count: tilesList.length });

  // Chunk size tuned to balance payload size and server load
  const CHUNK = 64;
  for (let i = 0; i < tilesList.length; i += CHUNK) {
    const chunk = tilesList.slice(i, i + CHUNK);
    try {
      const resp = await fetchTilesBatchWithFallback(chunk, z);
      for (const t of resp || []) {
        const arr = Array.isArray(t.strokes) ? t.strokes : [];
        // Persist authoritative list synchronously so rehydrate reads succeed immediately
        try { lsSaveTileStrokesSync(z, t.tx, t.ty, arr); } catch (e) {}
        const key = tileKey(t.tx, t.ty, z);
        const tile = tiles.get(key);
        if (tile) {
          resetTile(tile);
          const cached = lsLoadTileStrokes(z, t.tx, t.ty) || [];
          for (const s of cached) { if (s && s.id) { drawStrokeOnTile(tile, s); tile.seen.add(s.id); tile.cached.push(s); } }
          tile.dirty = true;
        }
        dlog('Populate LS: applied batch tile', { tile: key, strokes: arr.length });
      }
      // Yield to rendering between chunks
      await new Promise(r => setTimeout(r, 0));
    } catch (err) {
      dlog('Populate LS: batch fetch error', String(err));
    }
  }
  dlog('Populate LS: done');
}

function sendStroke(stroke) {
  const msg = { type: 'stroke', payload: stroke };
  if (wsReady) {
    try { ws.send(JSON.stringify(msg)); return; } catch {}
  }
  // fallback to HTTP
  // Debounce persist calls slightly so quick successive finalize events don't spam
  if (!sendStroke._timer) sendStroke._timer = null;
  if (!sendStroke._queue) sendStroke._queue = [];
  sendStroke._queue.push(stroke);
  clearTimeout(sendStroke._timer);
  sendStroke._timer = setTimeout(() => {
    const last = sendStroke._queue[sendStroke._queue.length - 1];
    sendStroke._queue.length = 0;
    dlog('HTTP persist stroke', { id: last?.id, points: last?.points?.length || 0 });
    fetch('/api/stroke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(last) }).catch(() => {});
  }, 200);
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => { wsReady = true; dlog('WS open'); });
  // Identify this connection as a peer (broadcast channel) with persisted session id if available
  ws.addEventListener('open', () => {
    try {
      let sid = null;
      try { sid = localStorage.getItem(LS_SESSION_ID) || null; } catch {}
      const payload = { role: 'peer' };
      if (sid) payload.id = sid;
      if (myName) payload.name = myName;
      // Provide a starting color so peers may see a consistent cursor before first presence broadcast
      payload.color = myColor;
      ws.send(JSON.stringify({ type: 'identify', payload }));
    } catch {}
  });
  ws.addEventListener('close', () => { wsReady = false; dlog('WS close'); setTimeout(connectWS, 1000); });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = msg || {};
    if (type === 'welcome') {
      myId = payload.id; myName = payload.name;
      // Persist session identity for future reloads
      try { localStorage.setItem(LS_SESSION_ID, String(myId || '')); } catch {}
      try { if (myName) localStorage.setItem(LS_SESSION_NAME, String(myName)); } catch {}
      for (const p of payload.others || []) { peers.set(p.id, p); }
      // Sync our current picker color to presence immediately
      const center = screenToWorld((canvas.width / STATE.dpr) / 2, (canvas.height / STATE.dpr) / 2);
      sendPresence(center);
      dlog('WS welcome', { peers: (payload.others||[]).length, id: myId });
      requestFrame();
    } else if (type === 'presence') {
      const { id, x, y, color, name } = payload;
      peers.set(id, { ...(peers.get(id) || {}), x, y, color, name });
      requestFrame();
    } else if (type === 'leave') {
      peers.delete(payload.id);
      requestFrame();
    } else if (type === 'stroke') {
      // Draw onto tiles
      dlog('WS stroke', { id: payload?.id, points: payload?.points?.length || 0 });
      const tilesTouched = tilesForStroke(payload);
      for (const { tx, ty } of tilesTouched) {
        const t = tryGetTile(tx, ty);
        if (!t) continue;
        if (!t.seen.has(payload.id)) {
          drawStrokeOnTile(t, payload);
          t.seen.add(payload.id);
          t.cached.push(payload);
          lsSaveTileStrokes(0, tx, ty, t.cached);
        }
      }
      requestFrame();
    }
  });
}

// UI handlers
toolPanBtn.addEventListener('click', () => setTool('pan'));
toolPenBtn.addEventListener('click', () => setTool('pen'));
toolEraserBtn.addEventListener('click', () => setTool('eraser'));
colorInput.addEventListener('input', () => {
  myColor = colorInput.value;
  localStorage.setItem('color', myColor);
  sendPresence(screenToWorld((canvas.width / STATE.dpr) / 2, (canvas.height / STATE.dpr) / 2));
});

sizeInput.addEventListener('input', () => {
  localStorage.setItem('size', sizeInput.value);
  if (activeStroke) activeStroke.size = Number(sizeInput.value) || activeStroke.size;
  requestFrame();
});

opacityInput.addEventListener('input', () => {
  localStorage.setItem('opacity', opacityInput.value);
  if (activeStroke) activeStroke.opacity = Number(opacityInput.value) || activeStroke.opacity;
  requestFrame();
});

function setTool(t) {
  tool = t;
  toolPanBtn.classList.toggle('active', t === 'pan');
  toolPenBtn.classList.toggle('active', t === 'pen');
  toolEraserBtn.classList.toggle('active', t === 'eraser');
  try { localStorage.setItem('tool', tool); } catch {}
}

// Input handling
canvas.addEventListener('pointerdown', (e) => {
  if (pointerId !== null) return;
  canvas.setPointerCapture(e.pointerId);
  pointerId = e.pointerId;
  const isPanMode = spaceHeld || e.button === 1 || tool === 'pan' || (tool !== 'pen' && tool !== 'eraser');
  const world = screenToWorld(e.clientX, e.clientY);
  if (isPanMode) {
    isPanning = true;
    lastPointer = { x: e.clientX, y: e.clientY };
  } else {
    isDrawing = true;
    activeStroke = {
      id: cryptoId(),
      userId: myId || 'anon',
      color: myColor,
      size: Number(sizeInput.value) || 12,
      opacity: Number(opacityInput.value) || 1,
      erase: tool === 'eraser',
      points: [world]
    };
  }
  requestFrame();
});

canvas.addEventListener('pointermove', (e) => {
  if (pointerId !== e.pointerId) {
    // still send presence
    const pt = screenToWorld(e.clientX, e.clientY);
    sendPresence(pt);
    return;
  }
  const pt = screenToWorld(e.clientX, e.clientY);
  if (isPanning && lastPointer) {
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    view.tx += dx; view.ty += dy;
    lastPointer = { x: e.clientX, y: e.clientY };
    updateUrlFromView();
  }
  if (isDrawing && activeStroke) {
    const last = activeStroke.points[activeStroke.points.length - 1];
    const dx = pt.x - last.x; const dy = pt.y - last.y;
    const minDist = 0.5 / Math.max(view.scale, 0.001);
    if (dx*dx + dy*dy >= minDist * minDist) {
      activeStroke.points.push(pt);
      if (activeStroke.erase && activeStroke.points.length >= 2) {
        const n = activeStroke.points.length;
        applyLiveEraserSegment(activeStroke, activeStroke.points[n - 2], activeStroke.points[n - 1]);
      }
    }
  }
  sendPresence(pt);
  requestFrame();
});

canvas.addEventListener('pointerup', (e) => {
  if (pointerId !== e.pointerId) return;
  canvas.releasePointerCapture(e.pointerId);
  pointerId = null;
  if (isPanning) {
    isPanning = false; lastPointer = null;
  }
  if (isDrawing && activeStroke) {
    finalizeStroke(activeStroke);
    isDrawing = false; activeStroke = null;
  }
});

canvas.addEventListener('pointercancel', () => {
  pointerId = null; isPanning = false; isDrawing = false; activeStroke = null; lastPointer = null; requestFrame();
});

// Wheel zoom
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = Math.pow(1.0015, -e.deltaY);
  zoomAt(e.clientX, e.clientY, delta);
}, { passive: false });

// Space to pan
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { spaceHeld = true; }
  if (e.key === 'b' || e.key === 'B') setTool('pen');
  if (e.key === 'e' || e.key === 'E') setTool('eraser');
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

// Grid toggle
if (gridToggle) {
  const saved = localStorage.getItem('showGrid');
  if (saved !== null) STATE.showGrid = saved === '1';
  gridToggle.checked = STATE.showGrid;
  gridToggle.addEventListener('change', () => {
    STATE.showGrid = gridToggle.checked;
    localStorage.setItem('showGrid', STATE.showGrid ? '1' : '0');
    requestFrame();
  });
}

// Zoom buttons (helpful on mobile where wheel isn't available)
if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomToCenter(1.15));
if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomToCenter(1 / 1.15));

// SVG export (visible area)
if (exportSvgBtn) exportSvgBtn.addEventListener('click', () => {
  try { exportVisibleAreaToSvg(); } catch (e) { dlog('SVG export failed', e && e.message); }
});

function strokeBBox(stroke) {
  const pts = Array.isArray(stroke?.points) ? stroke.points : [];
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  const pad = (Number(stroke.size) || 4) * 0.5;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function pathDataFromPoints(pts) {
  if (!Array.isArray(pts) || pts.length === 0) return '';
  const f = (n) => {
    const v = Math.round(Number(n) * 100) / 100; // 2dp to keep size small
    return Number.isFinite(v) ? String(v) : '0';
  };
  if (pts.length === 1) {
    const p = pts[0];
    return `M ${f(p.x)} ${f(p.y)}`;
  }
  if (pts.length === 2) {
    return `M ${f(pts[0].x)} ${f(pts[0].y)} L ${f(pts[1].x)} ${f(pts[1].y)}`;
  }
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const n = pts[i + 1];
    const mx = (Number(p.x) + Number(n.x)) / 2;
    const my = (Number(p.y) + Number(n.y)) / 2;
    d += ` Q ${f(p.x)} ${f(p.y)} ${f(mx)} ${f(my)}`;
  }
  const pPrev = pts[pts.length - 2];
  const pLast = pts[pts.length - 1];
  d += ` Q ${f(pPrev.x)} ${f(pPrev.y)} ${f(pLast.x)} ${f(pLast.y)}`;
  return d;
}

function cmpByTime(a, b) {
  const ta = Number(a?.t);
  const tb = Number(b?.t);
  const fa = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER;
  const fb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER;
  if (fa !== fb) return fa - fb;
  // Stable fallback: id
  const ida = String(a?.id || '');
  const idb = String(b?.id || '');
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

function exportFile(name, contents, mime = 'image/svg+xml') {
  try {
    const blob = new Blob([contents], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (e) { /* ignore */ }
}

async function exportVisibleAreaToSvg() {
  const dpr = STATE.dpr;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cssW, cssH);
  const visMinX = Math.min(tl.x, br.x);
  const visMinY = Math.min(tl.y, br.y);
  const visMaxX = Math.max(tl.x, br.x);
  const visMaxY = Math.max(tl.y, br.y);

  // Gather server-authoritative strokes for all visible tiles
  const tilesList = visibleTilesList();
  if (!tilesList.length) return;
  let tilesResp = [];
  try { tilesResp = await fetchTilesBatchWithFallback(tilesList, 0); } catch (_) { tilesResp = []; }
  const byId = new Map();
  for (const t of tilesResp || []) {
    const arr = Array.isArray(t?.strokes) ? t.strokes : [];
    for (const s of arr) {
      if (!s || !s.id) continue;
      const prev = byId.get(s.id);
      // Prefer instance that has a timestamp
      if (!prev || (!Number.isFinite(prev.t) && Number.isFinite(s.t))) {
        byId.set(s.id, s);
      }
    }
  }

  if (byId.size === 0) return;

  // Keep only strokes that intersect visible bbox (with small pad)
  const PAD = 2;
  const bboxIntersects = (bb) => bb && !(bb.maxX < (visMinX - PAD) || bb.maxY < (visMinY - PAD) || bb.minX > (visMaxX + PAD) || bb.minY > (visMaxY + PAD));

  const all = [];
  for (const s of byId.values()) {
    const bb = strokeBBox(s);
    if (bboxIntersects(bb)) all.push(s);
  }
  if (all.length === 0) return;

  // Compute tight bounding box around included strokes (including stroke width)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of all) {
    const bb = strokeBBox(s);
    if (!bb) continue;
    if (bb.minX < minX) minX = bb.minX;
    if (bb.minY < minY) minY = bb.minY;
    if (bb.maxX > maxX) maxX = bb.maxX;
    if (bb.maxY > maxY) maxY = bb.maxY;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;
  const W = Math.max(0, maxX - minX);
  const H = Math.max(0, maxY - minY);
  if (W <= 0 || H <= 0) return;

  // Separate into normal and eraser strokes and sort by time
  const erasers = all.filter(s => !!s.erase).sort(cmpByTime);
  const paints = all.filter(s => !s.erase).sort(cmpByTime);

  // Prebuild masks: one per suffix of erasers (later erasers should punch out earlier content)
  const masks = [];
  const maskIdForIndex = (idx) => `m${idx}`;
  for (let i = 0; i <= erasers.length; i++) {
    // mask i: white base minus all erasers with index >= i
    const parts = [];
    parts.push(`<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="white"/>`);
    for (let j = i; j < erasers.length; j++) {
      const e = erasers[j];
      const pts = Array.isArray(e.points) ? e.points : [];
      const sw = Number(e.size) || 4;
      const op = Number.isFinite(e.opacity) ? e.opacity : 1;
      if (pts.length === 1) {
        const p = pts[0];
        parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${sw / 2}" fill="black" fill-opacity="${op}"/>`);
      } else {
        const d = pathDataFromPoints(pts);
        if (!d) continue;
        // Black in mask removes content
        parts.push(`<path d="${d}" fill="none" stroke="black" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${op}"/>`);
      }
    }
    masks.push(`<mask id="${maskIdForIndex(i)}" maskUnits="userSpaceOnUse" x="${minX}" y="${minY}" width="${W}" height="${H}">${parts.join('')}</mask>`);
  }

  // Helper: first eraser index strictly after t
  const eraserTimes = erasers.map(e => Number(e.t));
  function firstEraserAfter(t) {
    if (!erasers.length) return erasers.length;
    const tt = Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
    let lo = 0, hi = eraserTimes.length; // [lo, hi)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (eraserTimes[mid] > tt) hi = mid; else lo = mid + 1;
    }
    return lo; // index of first > t, possibly length
  }

  // Build SVG content
  const header = `<?xml version="1.0" encoding="UTF-8"?>`;
  const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${minX} ${minY} ${W} ${H}" fill="none">`;
  const defs = `<defs>${masks.join('')}</defs>`;
  const bodyParts = [];

  for (const s of paints) {
    const pts = Array.isArray(s.points) ? s.points : [];
    const sw = Number(s.size) || 4;
    const color = String(s.color || '#000');
    const op = Number.isFinite(s.opacity) ? s.opacity : 1;
    const idx = firstEraserAfter(Number(s.t));
    const maskAttr = erasers.length && idx < erasers.length ? ` mask="url(#${maskIdForIndex(idx)})"` : '';
    if (pts.length === 1) {
      const p = pts[0];
      bodyParts.push(`<g${maskAttr}><circle cx="${p.x}" cy="${p.y}" r="${sw / 2}" fill="${color}" fill-opacity="${op}"/></g>`);
    } else {
      const d = pathDataFromPoints(pts);
      if (!d) continue;
      bodyParts.push(`<g${maskAttr}><path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${op}"/></g>`);
    }
  }

  const svg = `${header}\n${svgOpen}${defs}${bodyParts.join('')}</svg>`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  exportFile(`realtime-canvas-${ts}.svg`, svg);
}

function finalizeStroke(stroke) {
  // Draw onto tile canvases then broadcast/persist
  const tilesTouched = tilesForStroke(stroke);
  for (const { tx, ty } of tilesTouched) {
    const t = tryGetTile(tx, ty);
    if (!t) continue;
    if (!t.seen.has(stroke.id)) {
      drawStrokeOnTile(t, stroke);
      t.seen.add(stroke.id);
      t.cached.push(stroke);
      lsSaveTileStrokes(0, tx, ty, t.cached);
    }
  }
  sendStroke(stroke);
  requestFrame();
}

let lastPresenceAt = 0;
function sendPresence(pos) {
  if (!pos) return;
  const now = performance.now();
  if (now - lastPresenceAt < 500) return; // throttle to ~2Hz (every 500ms)
  lastPresenceAt = now;
  const msg = { type: 'presence', payload: { x: pos.x, y: pos.y, color: myColor, name: myName } };
  if (wsReady) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

function cryptoId() { try { return self.crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2); } }

// URL deep link
function loadViewFromUrl() {
  const dpr = STATE.dpr;
  const sp = new URLSearchParams(location.search);
  const x = Number(sp.get('x')); const y = Number(sp.get('y')); const z = Number(sp.get('z'));
  if (Number.isFinite(z)) view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, z));
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  if (Number.isFinite(x)) view.tx = -x * view.scale + cssW / 2;
  if (Number.isFinite(y)) view.ty = -y * view.scale + cssH / 2;
}

let lastUrlUpdate = 0;
function updateUrlFromView() {
  const dpr = STATE.dpr;
  const now = performance.now();
  if (now - lastUrlUpdate < 120) return; // throttle to avoid spam
  lastUrlUpdate = now;
  const center = screenToWorld((canvas.width / dpr) / 2, (canvas.height / dpr) / 2);
  const sp = new URLSearchParams(location.search);
  sp.set('x', center.x.toFixed(1));
  sp.set('y', center.y.toFixed(1));
  sp.set('z', view.scale.toFixed(3));
  history.replaceState(null, '', `?${sp.toString()}`);
}

// Boot
resize();
setTool(initialTool);
loadViewFromUrl();
connectWS();
// Register service worker to enable websocket-backed tile streaming proxy
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      dlog('ServiceWorker registered', reg && reg.scope);
      // Wait until active
      if (reg.waiting) return;
      if (reg.installing) {
        await new Promise(r => { reg.installing.addEventListener('statechange', () => { if (reg.active) r(); }); });
      }
    } catch (e) { dlog('SW register failed', e && e.message); }
  }
}

(async () => {
  try { await registerSW(); } catch {}
  // Populate LS for visible tiles at startup (works even if batch API is unavailable)
  populateVisibleFromServer().finally(() => { requestFrame(); });
})();
