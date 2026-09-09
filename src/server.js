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

// Initialize browser pool with optimized settings
const browserPool = new BrowserPool({
  maxBrowsers: 1,  // Reduced to 1 for free tier (512MB RAM)
  launchOptions: {
    headless: 'new',
    args: [
      // Core flags
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      
      // Performance optimizations
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-gl-drawing-for-tests',
      
      // Memory optimizations
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Use single process for lower memory
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
      
      // Speed optimizations
      '--disable-web-security', // Faster loading (use with caution)
      '--disable-features=VizDisplayCompositor',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-new-content-rendering-timeout',
      '--disable-image-animation-resync',
      '--run-all-compositor-stages-before-draw',
      '--disable-partial-raster',
      '--disable-skia-runtime-opts',
      '--disable-smooth-scrolling',
      '--disable-frame-rate-limit',
      
      // Network optimizations  
      '--disable-domain-reliability',
      '--disable-component-update',
      
      // Rendering optimizations
      '--autoplay-policy=user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--hide-scrollbars',
      '--ignore-gpu-blacklist'
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

// WebSocket server for streaming with compression enabled
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3 // Fast compression
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024 // Only compress messages > 1KB
  }
});
const streamManager = new StreamManager(browserPool);

wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket connection');
  
  let sessionId = null;
  let isProcessing = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 Received message:', data.type);
      
      switch (data.type) {
        case 'start':
          if (isProcessing) {
            console.log('⏳ Already processing a start request');
            return;
          }
          
          isProcessing = true;
          try {
            console.log(`🎬 Starting stream for ${data.url}`);
            sessionId = await streamManager.startStream(data.url, ws, {
              fps: data.fps || 20,
              quality: data.quality || 65,
              width: data.width || 1280,
              height: data.height || 720
            });
            
            if (ws.readyState === 1) { // OPEN
              ws.send(JSON.stringify({ type: 'started', sessionId }));
              console.log(`✅ Stream started: ${sessionId}`);
            }
          } catch (error) {
            console.error('❌ Failed to start stream:', error);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                message: error.message || 'Failed to start stream'
              }));
            }
          } finally {
            isProcessing = false;
          }
          break;
          
        case 'stop':
          if (sessionId) {
            try {
              await streamManager.stopStream(sessionId);
              sessionId = null;
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'stopped' }));
              }
            } catch (error) {
              console.error('Error stopping stream:', error);
            }
          }
          break;
          
        case 'interact':
          if (sessionId && data.action) {
            try {
              await streamManager.handleInteraction(sessionId, data.action);
            } catch (error) {
              console.error('Interaction error:', error);
            }
          }
          break;
          
        default:
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
          }
      }
    } catch (error) {
      console.error('❌ WebSocket message error:', error);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    }
  });

  ws.on('close', async () => {
    console.log('🔌 WebSocket disconnected');
    if (sessionId) {
      try {
        await streamManager.stopStream(sessionId);
      } catch (error) {
        console.error('Error stopping stream on disconnect:', error);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
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
