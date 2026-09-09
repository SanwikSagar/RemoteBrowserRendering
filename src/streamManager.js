import { randomUUID } from 'crypto';
import sharp from 'sharp';

export class StreamManager {
  constructor(browserPool) {
    this.browserPool = browserPool;
    this.sessions = new Map();
  }

  async startStream(url, ws, options = {}) {
    const sessionId = randomUUID();
    const fps = Math.min(options.fps || 30, 30); // Cap at 30 FPS for free tier
    const frameInterval = 1000 / fps;
    const quality = Math.min(Math.max(options.quality || 70, 50), 85); // Lower quality for speed
    const width = options.width || 1280;  // Lower resolution for free tier
    const height = options.height || 720; // Lower resolution for free tier

    console.log(`📹 Starting stream session ${sessionId} for ${url}`);
    console.log(`⚙️  Settings: ${fps} FPS, ${quality}% quality, ${width}x${height}`);

    const browser = await this.browserPool.acquire();
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({
      width,
      height,
      deviceScaleFactor: 1
    });

    // Aggressive optimization for performance
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      // Block heavy resources for faster loading
      if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
        // Allow first-party images only
        if (resourceType === 'image' && request.url().startsWith(url)) {
          request.continue();
        } else {
          request.abort();
        }
      } else {
        request.continue();
      }
    });

    // Disable unnecessary features for speed
    await page.setJavaScriptEnabled(true); // Keep JS for functionality
    await page.setCacheEnabled(false); // Disable cache for consistent testing

    // Navigate to URL with fast timeout
    try {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', // Faster than networkidle2
        timeout: 15000 // Reduced timeout
      });
    } catch (error) {
      console.error(`Failed to navigate to ${url}:`, error);
      this.browserPool.release(browser);
      throw error;
    }

    let isStreaming = true;
    let frameCount = 0;
    let lastFrameTime = Date.now();

    // Optimized streaming loop with better timing
    const streamLoop = async () => {
      if (!isStreaming) return;

      const startTime = Date.now();

      try {
        // Capture screenshot with optimized settings
        const screenshot = await page.screenshot({
          type: 'jpeg',
          quality,
          optimizeForSpeed: true, // Prioritize speed over size
          encoding: 'binary'
        });

        // Ultra-fast JPEG compression with Sharp
        const optimizedJpeg = await sharp(screenshot)
          .jpeg({ 
            quality: quality - 5, // Slightly lower for speed
            mozjpeg: true,
            chromaSubsampling: '4:2:0',
            optimizeScans: false, // Faster encoding
            progressive: false // Faster encoding
          })
          .toBuffer();

        // Send frame via WebSocket
        if (ws.readyState === 1) { // OPEN
          const frameData = {
            type: 'frame',
            sessionId,
            frame: optimizedJpeg.toString('base64'),
            frameNumber: frameCount++,
            timestamp: startTime
          };
          ws.send(JSON.stringify(frameData));
        }

        // Adaptive frame timing for consistent FPS
        const processingTime = Date.now() - startTime;
        const targetDelay = frameInterval;
        const nextFrameDelay = Math.max(0, targetDelay - processingTime);

        // Schedule next frame
        if (isStreaming) {
          setTimeout(streamLoop, nextFrameDelay);
        }

        lastFrameTime = startTime;
      } catch (error) {
        if (error.message.includes('Target closed')) {
          console.log(`Session ${sessionId} page closed`);
          isStreaming = false;
        } else {
          console.error('Streaming error:', error);
          // Continue streaming despite errors
          if (isStreaming) {
            setTimeout(streamLoop, frameInterval);
          }
        }
      }
    };

    // Start streaming immediately
    streamLoop();

    // Store session data
    this.sessions.set(sessionId, {
      browser,
      page,
      ws,
      stop: () => { isStreaming = false; }
    });

    return sessionId;
  }

  async stopStream(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`🛑 Stopping stream session ${sessionId}`);

    session.stop();
    
    try {
      await session.page.close();
    } catch (error) {
      console.error('Error closing page:', error);
    }

    this.browserPool.release(session.browser);
    this.sessions.delete(sessionId);
  }

  async handleInteraction(sessionId, action) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

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
          console.log(`📜 Scroll: ${action.deltaY}`);
          break;

        case 'type':
          await page.keyboard.type(action.text);
          console.log(`⌨️ Type: ${action.text}`);
          break;

        case 'key':
          await page.keyboard.press(action.key);
          console.log(`⌨️ Key: ${action.key}`);
          break;

        case 'navigate':
          if (action.action === 'back') {
            await page.goBack({ waitUntil: 'networkidle2' });
            console.log('⬅️ Navigate back');
          } else if (action.action === 'forward') {
            await page.goForward({ waitUntil: 'networkidle2' });
            console.log('➡️ Navigate forward');
          } else if (action.action === 'reload') {
            await page.reload({ waitUntil: 'networkidle2' });
            console.log('🔄 Reload page');
          } else if (action.action === 'goto' && action.url) {
            await page.goto(action.url, { waitUntil: 'networkidle2', timeout: 30000 });
            console.log(`🧭 Navigate to: ${action.url}`);
          }
          
          // Send updated URL to client
          const currentUrl = page.url();
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'pageInfo',
              sessionId,
              url: currentUrl
            }));
          }
          break;

        default:
          console.warn(`Unknown interaction type: ${action.type}`);
      }
    } catch (error) {
      console.error('Interaction error:', error);
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up all streaming sessions...');
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.stopStream(id)));
    console.log('✅ All sessions cleaned up');
  }
}
