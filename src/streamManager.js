import { randomUUID } from 'crypto';
import sharp from 'sharp';

export class StreamManager {
  constructor(browserPool) {
    this.browserPool = browserPool;
    this.sessions = new Map();
  }

  async startStream(url, ws, options = {}) {
    const sessionId = randomUUID();
    const fps = Math.min(options.fps || 20, 30);
    const frameInterval = 1000 / fps;
    const quality = Math.min(Math.max(options.quality || 60, 50), 90);
    // Use client-provided dimensions for responsive viewport
    const width = options.width || 1280;
    const height = options.height || 720;

    console.log(`📹 Starting stream session ${sessionId} for ${url}`);
    console.log(`⚙️  Settings: ${fps} FPS, ${quality}% quality, ${width}x${height}`);

    const sendProgress = (progress, message, subtext) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'progress',
          progress,
          message,
          subtext
        }));
      }
    };

    let browser = null;
    let page = null;

    try {
      sendProgress(5, 'Acquiring browser...', 'Initializing Puppeteer');
      browser = await this.browserPool.acquire();
      console.log('✅ Browser acquired');
      
      sendProgress(10, 'Creating page...', 'Setting up viewport');
      page = await browser.newPage();
      console.log('✅ Page created');

      // Set viewport
      await page.setViewport({
        width,
        height,
        deviceScaleFactor: 1
      });
      console.log('✅ Viewport set');

      // Simple resource blocking for memory efficiency
      sendProgress(15, 'Configuring resources...', 'Blocking ads and trackers');
      await page.setRequestInterception(true);
      
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        const requestUrl = request.url();
        
        // Aggressive blocking to save memory
        if (resourceType === 'media' || 
            resourceType === 'font' || 
            resourceType === 'image' && requestUrl.includes('ads') ||
            resourceType === 'stylesheet' && requestUrl.includes('analytics')) {
          request.abort().catch(() => {});
        } else if (requestUrl.includes('doubleclick') || 
                   requestUrl.includes('analytics') || 
                   requestUrl.includes('ads') ||
                   requestUrl.includes('tracking') ||
                   requestUrl.includes('facebook.com/tr') ||
                   requestUrl.includes('google-analytics')) {
          request.abort().catch(() => {});
        } else {
          request.continue().catch(() => {});
        }
      });
      
      console.log('✅ Request interception configured');

      // Disable JavaScript features that consume memory
      await page.evaluateOnNewDocument(() => {
        // Disable service workers
        delete window.navigator.serviceWorker;
        
        // Disable notifications
        window.Notification = undefined;
        
        // Disable Web Workers
        window.Worker = undefined;
        window.SharedWorker = undefined;
        
        // Disable WebRTC
        window.RTCPeerConnection = undefined;
        window.webkitRTCPeerConnection = undefined;
        window.mozRTCPeerConnection = undefined;
        
        // Disable IndexedDB
        window.indexedDB = undefined;
        
        console.log('Memory optimizations applied');
      });

      // Set user agent
      sendProgress(20, 'Setting user agent...', 'Preparing browser');
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // Navigate with timeout
      sendProgress(30, 'Navigating to page...', `Loading ${url}`);
      console.log(`🌐 Navigating to ${url}...`);
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        console.log('✅ Navigation successful');
        sendProgress(70, 'Page loaded', 'Processing content');
      } catch (navError) {
        console.warn(`⚠️ Navigation warning: ${navError.message}`);
        sendProgress(70, 'Page partially loaded', 'Continuing anyway...');
        // Continue anyway - page might have partially loaded
      }

      // Wait for page to stabilize
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('✅ Page stabilized');
      sendProgress(80, 'Stabilizing page...', 'Nearly ready');

      // Send initial page info
      sendProgress(85, 'Sending page info...', 'Almost ready');
      try {
        const currentUrl = page.url();
        const title = await page.title();
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'pageInfo',
            sessionId,
            url: currentUrl,
            title: title
          }));
        }
        console.log('✅ Page info sent');
      } catch (error) {
        console.warn('⚠️ Failed to get page info:', error.message);
      }

      sendProgress(90, 'Starting stream...', 'Capturing frames');

      let isStreaming = true;
      let frameCount = 0;
      let errorCount = 0;
      const maxErrors = 5;
      let lastScreenshot = null; // Track for memory cleanup

      // Streaming loop
      const streamLoop = async () => {
        if (!isStreaming) {
          // Clean up on exit
          lastScreenshot = null;
          return;
        }

        const startTime = Date.now();

        try {
          // Check if page is still alive
          if (page.isClosed()) {
            console.log(`Session ${sessionId} page closed`);
            isStreaming = false;
            lastScreenshot = null;
            return;
          }

          // Capture screenshot
          const screenshot = await page.screenshot({
            type: 'jpeg',
            quality,
            encoding: 'binary',
            optimizeForSpeed: true // Prioritize speed over size
          });

          // Clear previous screenshot from memory
          if (lastScreenshot) {
            lastScreenshot = null;
          }

          // Compress with Sharp - HIGH QUALITY, FAST compression
          const optimizedJpeg = await sharp(screenshot)
            .resize(width, height, {
              fit: 'inside',
              withoutEnlargement: true,
              fastShrinkOnLoad: true // Performance boost
            })
            .jpeg({ 
              quality,
              mozjpeg: true,
              chromaSubsampling: '4:4:4',  // Full chroma for quality
              trellisQuantisation: true,    // Better quality
              overshootDeringing: true,     // Reduce artifacts
              optimizeScans: true,          // Optimize progressive scans
              quantisationTable: 3          // Use optimal quantisation
            })
            .toBuffer();

          lastScreenshot = screenshot;

          // Send frame
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'frame',
              sessionId,
              frame: optimizedJpeg.toString('base64'),
              frameNumber: frameCount++,
              timestamp: startTime
            }));
            
            errorCount = 0; // Reset on success
          }

          // Aggressive memory cleanup every 50 frames
          if (frameCount % 50 === 0) {
            if (global.gc) {
              global.gc();
            }
          }

          // Schedule next frame
          const processingTime = Date.now() - startTime;
          const nextDelay = Math.max(10, frameInterval - processingTime);

          if (isStreaming) {
            setTimeout(streamLoop, nextDelay);
          } else {
            lastScreenshot = null;
          }
        } catch (error) {
          errorCount++;
          
          if (error.message.includes('closed')) {
            console.log(`Session ${sessionId} closed`);
            isStreaming = false;
            lastScreenshot = null;
            return;
          }
          
          console.error(`❌ Streaming error (${errorCount}/${maxErrors}):`, error.message);
          
          if (errorCount >= maxErrors) {
            console.error(`Too many errors, stopping stream ${sessionId}`);
            isStreaming = false;
            lastScreenshot = null;
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Streaming stopped due to errors'
              }));
            }
            return;
          }
          
          // Retry with backoff
          if (isStreaming) {
            setTimeout(streamLoop, frameInterval * 2);
          }
        }
      };

      // Start streaming
      console.log('🎬 Starting stream loop...');
      sendProgress(95, 'Streaming started!', 'Ready to stream');
      streamLoop();

      // Store session
      this.sessions.set(sessionId, {
        browser,
        page,
        ws,
        stop: () => { isStreaming = false; }
      });

      console.log(`✅ Stream ${sessionId} fully initialized`);
      sendProgress(100, 'Stream ready!', 'Enjoy your browsing');
      return sessionId;

    } catch (error) {
      console.error(`❌ Failed to start stream: ${error.message}`);
      console.error(error.stack);
      
      sendProgress(0, 'Stream failed', error.message);
      
      // Cleanup on failure
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.error('Error closing page:', e.message);
        }
      }
      if (browser) {
        this.browserPool.release(browser);
      }
      
      throw error;
    }
  }

  async stopStream(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`Session ${sessionId} not found`);
      return;
    }

    console.log(`🛑 Stopping stream session ${sessionId}`);

    session.stop();
    
    try {
      await session.page.close();
    } catch (error) {
      console.error('Error closing page:', error.message);
    }

    this.browserPool.release(session.browser);
    this.sessions.delete(sessionId);
    
    console.log(`✅ Session ${sessionId} stopped`);
  }

  async handleInteraction(sessionId, action) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`Session ${sessionId} not found for interaction`);
      return;
    }

    const { page, ws } = session;

    try {
      switch (action.type) {
        case 'click':
          await page.mouse.click(action.x, action.y, {
            button: action.button === 'right' ? 'right' : 'left'
          });
          console.log(`🖱️ Click at (${action.x}, ${action.y})`);
          break;

        case 'scroll':
          await page.evaluate((deltaY) => {
            window.scrollBy(0, deltaY);
          }, action.deltaY);
          break;

        case 'type':
          await page.keyboard.type(action.text);
          break;

        case 'key':
          await page.keyboard.press(action.key);
          break;

        case 'navigate':
          if (action.action === 'back') {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
          } else if (action.action === 'forward') {
            await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 });
          } else if (action.action === 'reload') {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          } else if (action.action === 'goto' && action.url) {
            await page.goto(action.url, { 
              waitUntil: 'domcontentloaded', 
              timeout: 30000 
            });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          // Send updated URL
          try {
            const currentUrl = page.url();
            const title = await page.title();
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'pageInfo',
                sessionId,
                url: currentUrl,
                title: title
              }));
            }
          } catch (error) {
            console.warn('Failed to get page info after navigation:', error.message);
          }
          break;

        default:
          console.warn(`Unknown interaction type: ${action.type}`);
      }
    } catch (error) {
      console.error('Interaction error:', error.message);
      throw error;
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up all streaming sessions...');
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.stopStream(id)));
    console.log('✅ All sessions cleaned up');
  }
}
