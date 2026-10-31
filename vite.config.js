import { defineConfig } from 'vite';

// Frontend lives in client/, builds to dist/ (served by the Node server in production).
// In dev, Vite runs on :5173 and forwards the API and sample clips to the server on :3000.
const API = 'http://localhost:3000'; // matches `--port 3000` in the dev:server script

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true, // reachable from a phone on the same Wi-Fi (mic still needs https there)
    proxy: {
      '/ws': { target: API, ws: true },
      '/test_clips': API,
      '/health': API,
    },
  },
});
