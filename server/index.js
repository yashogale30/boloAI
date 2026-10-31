import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { cfg, missingKeys } from './config.js';
import { startSession } from './session.js';

const missing = missingKeys();
if (missing.length) {
  console.warn(`[Warning] Missing API keys: ${missing.join(', ')}. Live STT/LLM/TTS requires them in .env (see .env.example). Serving static clips and health endpoints.`);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist');
const app = express();
// Production: serve the Vite build. In dev, Vite serves the frontend on :5173 instead.
if (fs.existsSync(dist)) app.use(express.static(dist));
else app.get('/', (_req, res) => res.type('text').send('Frontend not built. Run `npm run build`, or use `npm run dev` and open http://localhost:5173'));
app.use('/test_clips', express.static(path.join(root, '..', 'test_clips')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
wss.on('connection', (ws) => startSession(ws, cfg));

// Drop dead connections (e.g. a phone that lost signal) so their upstream streams close.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 15000);
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${cfg.port} is already in use, probably by another copy of this server.\n` +
        `Stop it (close its terminal or press Ctrl+C there), or find it with:  netstat -ano | findstr :${cfg.port}\n`,
    );
    process.exit(1);
  }
  throw err;
});
wss.on('error', () => {}); // listen errors are reported once, above

server.listen(cfg.port, () => {
  console.log(`Live translator on http://localhost:${cfg.port}`);
  console.log(`STT ${cfg.sttModel}/${cfg.sttLanguage} | LLM ${cfg.llmModel} | TTS ${cfg.ttsModel}`);
});
