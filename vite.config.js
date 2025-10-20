import { defineConfig } from 'vite';

// Vite configuration for the client app
// - Root set to `client`
// - Service worker served from `client/public/sw.js`
// - Build output in `client/dist`
// - Dev proxy forwards API and WS to Bun server
export default defineConfig({
  root: 'client',
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

