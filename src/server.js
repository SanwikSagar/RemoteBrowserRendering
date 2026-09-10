import express from 'express';
import { WebSocketServer } from 'ws';
import { BrowserPool } from './browserPool.js';
import { StreamManager, normalizeRemoteUrl } from './streamManager.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG_STREAM === '1';
const log = (message, details = '') => console.log(`[RBR] ${message}${details ? ` ${details}` : ''}`);
app.use((req, res, next) => {
  // data: is permitted only as a non-network connection target because shader
  // loaders commonly use data:text/plain URLs. Scripts remain same-origin.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '16kb' }));
// The client and server speak a versioned binary protocol. Never keep an old
// browser.js in a visitor's cache after a deploy.
app.use(express.static(path.join(__dirname, '../public'), { maxAge: 0, etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

const browserPool = new BrowserPool({
  maxBrowsers: Number(process.env.MAX_BROWSERS) || 1,
  launchOptions: { 
    headless: true, 
    args: [
      // Security
      '--no-sandbox', '--disable-setuid-sandbox',
      // /dev/shm is tiny in a container, so Chrome must not try to use it
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-accelerated-2d-canvas',
      '--disable-extensions',
      '--disable-plugins',
      // One shared renderer keeps the process count, and therefore RSS, low enough
      // to survive a 512MB container.
      '--disable-features=IsolateOrigins,site-per-process,TranslateUI,BackForwardCache,AcceptCHFrame',
      '--renderer-process-limit=1',
      '--enable-low-end-device-mode',
      '--js-flags=--max-old-space-size=192',
      // A single raster thread avoids oversubscribing half a vCPU
      '--num-raster-threads=1',
      // Network optimizations
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-default-apps',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      // Frames must keep painting even though the window is never focused
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      // Audio
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      // Visual optimizations
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--disable-smooth-scrolling',
      '--enable-features=NetworkServiceInProcess',
      '--disable-blink-features=AutomationControlled'
    ] 
  }
});
await browserPool.initialize();

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
const server = app.listen(PORT, () => log(`listening on ${PORT}`, `debug=${DEBUG}`));
const wss = new WebSocketServer({ 
  server, 
  maxPayload: 16 * 1024, 
  perMessageDeflate: false,
  // Performance optimizations
  clientTracking: true,
  backlog: 100
});
const streamManager = new StreamManager(browserPool);

// Periodic cleanup of stale sessions (every 30 seconds)
setInterval(() => {
  for (const [sessionId, session] of streamManager.sessions.entries()) {
    // Clean up sessions with closed WebSocket connections
    if (!session.ws || session.ws.readyState === session.ws.CLOSED || session.ws.readyState === session.ws.CLOSING) {
      log('cleaning stale session', `session=${sessionId.slice(0, 8)}`);
      streamManager.stopStream(sessionId).catch(() => {});
    }
  }
}, 30_000);

wss.on('connection', (ws) => {
  log('websocket connected');
  let sessionId = null, starting = false, messages = 0, lastMessageTime = Date.now();
  const resetRate = setInterval(() => { messages = 0; }, 1000);
  
  // Set TCP keepalive to detect dead connections
  if (ws._socket) {
    ws._socket.setKeepAlive(true, 30000);
    ws._socket.setNoDelay(true); // Disable Nagle's algorithm for lower latency
  }
  
  ws.on('message', async (message, isBinary) => {
    const now = Date.now();
    lastMessageTime = now;
    
    if (isBinary || ++messages > 120 || message.length > 16 * 1024) return ws.close(1008, 'Invalid message rate');
    let data;
    try { data = JSON.parse(message.toString()); }
    catch { return ws.send(JSON.stringify({ type: 'error', message: 'Invalid message.' })); }
    try {
      if (DEBUG) log('command', `${data.type}${data.sessionId ? ` session=${data.sessionId.slice(0, 8)}` : ''}`);
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
      } else if (data.type === 'tab' && data.sessionId === sessionId) {
        if (data.action === 'create') await streamManager.createTab(sessionId, data.url);
        else if (data.action === 'switch') await streamManager.switchTab(sessionId, data.tabId);
        else if (data.action === 'close') await streamManager.closeTab(sessionId, data.tabId);
        else throw new Error('Unsupported tab action.');
      } else if (data.type === 'interact' && data.sessionId === sessionId) {
        await streamManager.handleInteraction(sessionId, data.action);
      } else throw new Error('Invalid session or command.');
    } catch (error) {
      log('command error', error.message || 'unknown error');
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: error.message || 'Request failed.' }));
    } finally { starting = false; }
  });
  
  // Ping-pong to detect dead connections
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      // Check if no messages in the last 60 seconds and session is active
      if (sessionId && Date.now() - lastMessageTime > 60_000) {
        try {
          ws.ping();
        } catch (e) {
          log('ping failed, closing connection', sessionId ? `session=${sessionId.slice(0, 8)}` : '');
          ws.terminate();
        }
      }
    }
  }, 30_000);
  
  ws.on('pong', () => {
    lastMessageTime = Date.now();
  });
  
  ws.on('close', async () => { 
    clearInterval(resetRate); 
    clearInterval(pingInterval);
    log('websocket closed', sessionId ? `session=${sessionId.slice(0, 8)}` : 'no session'); 
    if (sessionId) await streamManager.stopStream(sessionId); 
  });
  
  ws.on('error', (error) => {
    log('websocket error', error.message || 'unknown');
  });
});

const shutdown = async () => { await streamManager.cleanup(); await browserPool.cleanup(); server.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
