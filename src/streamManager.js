import { randomUUID } from 'crypto';
import sharp from 'sharp';

export class StreamManager {
  constructor(browserPool) {
    this.browserPool = browserPool;
    this.sessions = new Map();
  }

  async startStream(url, ws, options = {}) {
    const sessionId = randomUUID();
    const fps = Math.min(options.fps || 30, 60);
    const frameInterval = 1000 / fps;
    const quality = Math.min(Math.max(options.quality || 45, 30), 70);
    const width = options.width || 1280;
    const height = options.height || 720;
    const isMobile = options.isMobile || false;

    console.log(`Starting stream session ${sessionId} for ${url}`);
    console.log(`Settings: ${fps} FPS, ${quality}% quality, ${width}x${height}, Mobile: ${isMobile}`);

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
      sendProgress(5, 'Acquiring browser...', 'Initializing');
      browser = await this.browserPool.acquire();
      
      sendProgress(10, 'Creating page...', 'Setting up viewport');
      page = await browser.newPage();

      // Set user agent BEFORE viewport for proper mobile detection
      const userAgent = isMobile 
        ? 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      
      await page.setUserAgent(userAgent);

      // Set viewport with proper mobile configuration
      await page.setViewport({
        width,
        height,
        deviceScaleFactor: isMobile ? 3 : 1,
        isMobile: isMobile,
        hasTouch: isMobile,
        isLandscape: false
      });

      // Set extra mobile-specific headers
      if (isMobile) {
        await page.setExtraHTTPHeaders({
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Ch-Ua-Mobile': '?1',
          'Sec-Ch-Ua-Platform': '"Android"'
        });
      }

      sendProgress(15, 'Configuring resources...', 'Optimizing performance');
      await page.setRequestInterception(true);
      
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        const requestUrl = request.url();
        
        if (resourceType === 'media' || 
            resourceType === 'font' || 
            resourceType === 'websocket' ||
            requestUrl.includes('doubleclick') || 
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

      await page.evaluateOnNewDocument(() => {
        delete window.navigator.serviceWorker;
        window.Notification = undefined;
        window.Worker = undefined;
        window.SharedWorker = undefined;
        window.RTCPeerConnection = undefined;
        if ('webkitRTCPeerConnection' in window) {
          window.webkitRTCPeerConnection = undefined;
        }
        window.indexedDB = undefined;
      });

      sendProgress(20, 'Setting user agent...', 'Preparing browser');
      sendProgress(30, 'Navigating to page...', `Loading ${url}`);
      
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        sendProgress(70, 'Page loaded', 'Processing content');
      } catch (navError) {
        sendProgress(70, 'Page partially loaded', 'Continuing...');
      }

      await new Promise(resolve => setTimeout(resolve, 500));
      sendProgress(80, 'Stabilizing page...', 'Nearly ready');

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
      } catch (error) {
        console.warn('Failed to get page info:', error.message);
      }

      sendProgress(90, 'Starting stream...', 'Capturing frames');

      let isStreaming = true;
      let frameCount = 0;
      let errorCount = 0;
      const maxErrors = 5;

      // Calculate downscaled dimensions for server processing
      const downscaleWidth = Math.round(width * 0.6);   // 60% size for extreme compression
      const downscaleHeight = Math.round(height * 0.6);

      const streamLoop = async () => {
        if (!isStreaming) {
          return;
        }

        const startTime = Date.now();

        try {
          if (page.isClosed()) {
            isStreaming = false;
            return;
          }

          // Ultra-fast screenshot at reduced resolution
          const screenshot = await page.screenshot({
            type: 'jpeg',
            quality: 60,                    // Reasonable JPEG quality
            encoding: 'binary',
            optimizeForSpeed: true,
            clip: {
              x: 0,
              y: 0,
              width: width,
              height: height
            }
          });

          // Minimal server-side processing - just downscale and compress
          const optimizedImage = await sharp(screenshot)
            .resize(downscaleWidth, downscaleHeight, {
              kernel: 'cubic',              // Better quality for upscaling
              fastShrinkOnLoad: true
            })
            .webp({
              quality: 50,                  // Balanced quality
              effort: 0,                    // Fastest encoding
              smartSubsample: true,
              preset: 'picture'
            })
            .toBuffer();

          if (ws.readyState === 1) {
            const frameSize = Math.round(optimizedImage.length / 1024);
            
            // Log frame size every 30 frames for monitoring
            if (frameCount % 30 === 0) {
              console.log(`Frame ${frameCount}: ${frameSize} KB | ${downscaleWidth}×${downscaleHeight} → ${width}×${height}`);
            }
            
            // Send with dimensions for client-side upscaling
            ws.send(JSON.stringify({
              type: 'frame',
              sessionId,
              frame: optimizedImage.toString('base64'),
              frameNumber: frameCount++,
              timestamp: startTime,
              width: downscaleWidth,
              height: downscaleHeight,
              targetWidth: width,
              targetHeight: height
            }));
            
            errorCount = 0;
          }

          if (frameCount % 50 === 0 && global.gc) {
            global.gc();
          }

          const processingTime = Date.now() - startTime;
          const nextDelay = Math.max(0, frameInterval - processingTime);

          if (isStreaming) {
            setTimeout(streamLoop, nextDelay);
          }
        } catch (error) {
          errorCount++;
          
          if (error.message.includes('closed') || error.message.includes('Target closed')) {
            console.log('Page closed, stopping stream');
            isStreaming = false;
            return;
          }
          
          console.error(`Streaming error (${errorCount}/${maxErrors}):`, error.message);
          
          if (errorCount >= maxErrors) {
            console.error(`Too many errors, stopping stream ${sessionId}`);
            isStreaming = false;
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Stream error: ${error.message}`
              }));
            }
            return;
          }
          
          if (isStreaming) {
            setTimeout(streamLoop, frameInterval);
          }
        }
      };

      sendProgress(95, 'Streaming started', 'Ready');
      sendProgress(100, 'Stream ready', 'Connected');
      
      streamLoop();

      this.sessions.set(sessionId, {
        browser,
        page,
        ws,
        stop: () => { isStreaming = false; }
      });

      return sessionId;

    } catch (error) {
      console.error(`Failed to start stream: ${error.message}`);
      
      sendProgress(0, 'Stream failed', error.message);
      
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
      return;
    }

    session.stop();
    
    try {
      await session.page.close();
    } catch (error) {
      console.error('Error closing page:', error.message);
    }

    this.browserPool.release(session.browser);
    this.sessions.delete(sessionId);
  }

  async handleInteraction(sessionId, action) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const { page, ws } = session;

    try {
      switch (action.type) {
        case 'click':
          await page.mouse.click(action.x, action.y, {
            button: action.button === 'right' ? 'right' : 'left'
          });
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
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.stopStream(id)));
  }
}
