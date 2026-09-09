import { randomUUID } from 'crypto';
import sharp from 'sharp';

export class StreamManager {
  constructor(browserPool) {
    this.browserPool = browserPool;
    this.sessions = new Map();
  }

  async startStream(url, ws, options = {}) {
    const sessionId = randomUUID();
    const fps = Math.min(options.fps || 60, 60); // Cap at 60 FPS
    const frameInterval = 1000 / fps;
    const quality = Math.min(Math.max(options.quality || 80, 1), 100);
    const width = options.width || 1920;
    const height = options.height || 1080;

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

    // Optimize for performance
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      // Block unnecessary resources for faster loading
      const resourceType = request.resourceType();
      if (['font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Navigate to URL
    try {
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
    } catch (error) {
      console.error(`Failed to navigate to ${url}:`, error);
      this.browserPool.release(browser);
      throw error;
    }

    let isStreaming = true;
    let frameCount = 0;
    let lastFrameTime = Date.now();

    // Streaming loop with frame timing
    const streamLoop = async () => {
      if (!isStreaming) return;

      const now = Date.now();
      const elapsed = now - lastFrameTime;

      try {
        // Capture screenshot
        const screenshot = await page.screenshot({
          type: 'jpeg',
          quality,
          optimizeForSpeed: true
        });

        // Further optimize JPEG with sharp for smaller size
        const optimizedJpeg = await sharp(screenshot)
          .jpeg({ 
            quality, 
            mozjpeg: true,
            chromaSubsampling: '4:2:0'
          })
          .toBuffer();

        // Send frame via WebSocket
        if (ws.readyState === 1) { // OPEN
          const frameData = {
            type: 'frame',
            sessionId,
            frame: optimizedJpeg.toString('base64'),
            frameNumber: frameCount++,
            timestamp: now
          };
          ws.send(JSON.stringify(frameData));
        }

        // Calculate next frame timing
        const processingTime = Date.now() - now;
        const nextFrameDelay = Math.max(0, frameInterval - processingTime);

        // Schedule next frame
        if (isStreaming) {
          setTimeout(streamLoop, nextFrameDelay);
        }

        lastFrameTime = now;
      } catch (error) {
        if (error.message.includes('Target closed')) {
          console.log(`Session ${sessionId} page closed`);
          isStreaming = false;
        } else {
          console.error('Streaming error:', error);
        }
      }
    };

    // Start streaming
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
