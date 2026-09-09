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
    const quality = Math.min(Math.max(options.quality || 60, 50), 90);
    const width = options.width || 1280;
    const height = options.height || 720;

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

    // Smart resource management - allow critical resources for proper rendering
    await page.setRequestInterception(true);
    const blockedDomains = new Set([
      'doubleclick.net',
      'googlesyndication.com',
      'googletagmanager.com',
      'facebook.com/tr',
      'analytics.google.com',
      'google-analytics.com',
      'hotjar.com',
      'mouseflow.com',
      'luckyorange.com'
    ]);

    page.on('request', (request) => {
      const resourceType = request.resourceType();
      const requestUrl = request.url();
      
      // Block ads and trackers
      if (blockedDomains.some(domain => requestUrl.includes(domain))) {
        request.abort();
        return;
      }
      
      // Allow critical resources but block heavy media
      if (resourceType === 'media' || resourceType === 'font') {
        request.abort();
      } else if (resourceType === 'image') {
        // Only allow images from main domain
        try {
          const pageOrigin = new URL(url).origin;
          const resourceOrigin = new URL(requestUrl).origin;
          if (pageOrigin === resourceOrigin || requestUrl.includes('logo') || requestUrl.includes('icon')) {
            request.continue();
          } else {
            request.abort();
          }
        } catch {
          request.abort();
        }
      } else {
        request.continue();
      }
    });

    // Enable JavaScript for modern sites
    await page.setJavaScriptEnabled(true);
    await page.setCacheEnabled(true); // Enable cache for faster repeated loads

    // Set user agent to avoid bot detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to URL with retries
    let navigationSuccess = false;
    let lastError = null;
    const maxRetries = 2;
    
    for (let i = 0; i < maxRetries && !navigationSuccess; i++) {
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 // Increased timeout for complex sites
        });
        navigationSuccess = true;
      } catch (error) {
        lastError = error;
        console.warn(`Navigation attempt ${i + 1} failed for ${url}:`, error.message);
        
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    if (!navigationSuccess) {
      console.error(`Failed to navigate to ${url} after ${maxRetries} attempts:`, lastError);
      await page.close();
      this.browserPool.release(browser);
      throw lastError;
    }

    // Wait a bit for dynamic content to load
    try {
      await page.waitForTimeout(1000);
    } catch (error) {
      console.warn('Wait for timeout failed:', error);
    }

    let isStreaming = true;
    let frameCount = 0;
    let lastFrameTime = Date.now();
    let errorCount = 0;
    const maxErrors = 5;

    // Send initial page info
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
      console.warn('Failed to get initial page info:', error);
    }

    // Optimized streaming loop with adaptive quality
    const streamLoop = async () => {
      if (!isStreaming) return;

      const startTime = Date.now();

      try {
        // Check if page is still alive
        if (page.isClosed()) {
          console.log(`Session ${sessionId} page closed`);
          isStreaming = false;
          return;
        }

        // Capture screenshot with optimized settings
        const screenshot = await page.screenshot({
          type: 'jpeg',
          quality,
          optimizeForSpeed: true,
          encoding: 'binary'
        });

        // Fast JPEG compression with Sharp
        const optimizedJpeg = await sharp(screenshot)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ 
            quality: quality,
            mozjpeg: true,
            chromaSubsampling: '4:2:0',
            optimizeScans: false,
            progressive: false
          })
          .toBuffer();

        // Send frame via WebSocket
        if (ws.readyState === 1) {
          const frameData = {
            type: 'frame',
            sessionId,
            frame: optimizedJpeg.toString('base64'),
            frameNumber: frameCount++,
            timestamp: startTime
          };
          ws.send(JSON.stringify(frameData));
          
          // Reset error count on success
          errorCount = 0;
        }

        // Adaptive frame timing
        const processingTime = Date.now() - startTime;
        const targetDelay = frameInterval;
        const nextFrameDelay = Math.max(10, targetDelay - processingTime);

        // Schedule next frame
        if (isStreaming) {
          setTimeout(streamLoop, nextFrameDelay);
        }

        lastFrameTime = startTime;
      } catch (error) {
        errorCount++;
        
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
          console.log(`Session ${sessionId} closed`);
          isStreaming = false;
          return;
        }
        
        console.error(`Streaming error (${errorCount}/${maxErrors}):`, error.message);
        
        // Stop streaming if too many errors
        if (errorCount >= maxErrors) {
          console.error(`Too many errors in session ${sessionId}, stopping stream`);
          isStreaming = false;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Too many streaming errors'
            }));
          }
          return;
        }
        
        // Continue streaming with exponential backoff
        if (isStreaming) {
          const backoffDelay = frameInterval * Math.pow(2, Math.min(errorCount, 3));
          setTimeout(streamLoop, backoffDelay);
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
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log('⬅️ Navigate back');
          } else if (action.action === 'forward') {
            await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log('➡️ Navigate forward');
          } else if (action.action === 'reload') {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log('🔄 Reload page');
          } else if (action.action === 'goto' && action.url) {
            await page.goto(action.url, { 
              waitUntil: 'domcontentloaded', 
              timeout: 30000 
            });
            console.log(`🧭 Navigate to: ${action.url}`);
            
            // Wait for page to stabilize
            await page.waitForTimeout(500);
          }
          
          // Send updated URL to client
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
            console.warn('Failed to get page info:', error);
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
