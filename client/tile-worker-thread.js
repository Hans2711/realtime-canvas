// Lightweight wrapper used by TileManager to spawn a dedicated worker thread
// This script is intentionally simple - it proxies messages between the main
// thread and the real service worker script by importing it as a worker.

// Note: this file should be served at /tile-worker-thread.js and simply
// references the real worker script (tile-worker.js). We keep it separate so
// the TileManager can create multiple dedicated workers (not service workers).

importScripts('/tile-worker.js');

// Nothing else here - the worker implementation in tile-worker.js will run.

