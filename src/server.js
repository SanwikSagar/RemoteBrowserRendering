import express from 'express';
import { WebSocketServer } from 'ws';
import { BrowserPool } from './browserPool.js';
import { StreamManager, normalizeRemoteUrl } from './streamManager.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
app.use((req, res, next) => {
  // data: is permitted only as a non-network connection target because shader
  // loaders commonly use data:text/plain URLs. Scripts remain same-origin.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '../public'), { maxAge: '1h', etag: true }));

const browserPool = new BrowserPool({
  maxBrowsers: Number(process.env.MAX_BROWSERS) || 1,
  launchOptions: { headless: true, args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb'
  ] }
});
await browserPool.initialize();

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
const server = app.listen(PORT, () => console.log(`Remote Browser Rendering listening on ${PORT}`));
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });
const streamManager = new StreamManager(browserPool);

wss.on('connection', (ws) => {
  let sessionId = null, starting = false, messages = 0;
  const resetRate = setInterval(() => { messages = 0; }, 1000);
  ws.on('message', async (message, isBinary) => {
    if (isBinary || ++messages > 120 || message.length > 16 * 1024) return ws.close(1008, 'Invalid message rate');
    let data;
    try { data = JSON.parse(message.toString()); }
    catch { return ws.send(JSON.stringify({ type: 'error', message: 'Invalid message.' })); }
    try {
      if (data.type === 'start') {
        if (starting) return;
        starting = true;
        if (sessionId) await streamManager.stopStream(sessionId);
        sessionId = await streamManager.startStream(normalizeRemoteUrl(data.url), ws, data);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'started', sessionId }));
      } else if (data.type === 'stop' && data.sessionId === sessionId) {
        await streamManager.stopStream(sessionId); sessionId = null;
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'stopped' }));
      } else if (data.type === 'update' && data.sessionId === sessionId) {
        streamManager.updateStream(sessionId, data);
      } else if (data.type === 'interact' && data.sessionId === sessionId) {
        await streamManager.handleInteraction(sessionId, data.action);
      } else throw new Error('Invalid session or command.');
    } catch (error) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: error.message || 'Request failed.' }));
    } finally { starting = false; }
  });
  ws.on('close', async () => { clearInterval(resetRate); if (sessionId) await streamManager.stopStream(sessionId); });
});

const shutdown = async () => { await streamManager.cleanup(); await browserPool.cleanup(); server.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
