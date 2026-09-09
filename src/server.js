import express from 'express';
import { WebSocketServer } from 'ws';
import { BrowserPool } from './browserPool.js';
import { StreamManager } from './streamManager.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize browser pool
const browserPool = new BrowserPool({
  maxBrowsers: 1,  // Reduced to 1 for free tier (512MB RAM)
  launchOptions: {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--disable-default-apps',
      '--mute-audio',
      '--no-default-browser-check',
      '--autoplay-policy=user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-features=AudioServiceOutOfProcess',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-print-preview',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-speech-api',
      '--hide-scrollbars',
      '--ignore-gpu-blacklist',
      '--metrics-recording-only',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain',
      '--force-color-profile=srgb',
      '--disable-blink-features=AutomationControlled'
    ]
  }
});

await browserPool.initialize();

// HTTP Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 Remote Browser Rendering Server running on port ${PORT}`);
  console.log(`📺 Open http://localhost:${PORT} to view the client`);
});

// WebSocket server for streaming
const wss = new WebSocketServer({ server });
const streamManager = new StreamManager(browserPool);

wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket connection');
  
  let sessionId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'start':
          sessionId = await streamManager.startStream(data.url, ws, {
            fps: data.fps || 60,
            quality: data.quality || 80,
            width: data.width || 1920,
            height: data.height || 1080
          });
          ws.send(JSON.stringify({ type: 'started', sessionId }));
          break;
          
        case 'stop':
          if (sessionId) {
            await streamManager.stopStream(sessionId);
            sessionId = null;
          }
          ws.send(JSON.stringify({ type: 'stopped' }));
          break;
          
        case 'interact':
          if (sessionId && data.action) {
            await streamManager.handleInteraction(sessionId, data.action);
          }
          break;
          
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', async () => {
    console.log('🔌 WebSocket disconnected');
    if (sessionId) {
      await streamManager.stopStream(sessionId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await streamManager.cleanup();
  await browserPool.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await streamManager.cleanup();
  await browserPool.cleanup();
  process.exit(0);
});
