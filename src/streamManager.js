import { randomUUID } from 'crypto';
import sharp from 'sharp';

export class StreamManager {
  constructor(browserPool) {
    this.browserPool = browserPool;
    this.sessions = new Map();
    this.TILE_SIZE = 64; // 64x64 tiles for optimal performance
  }

  async startStream(url, ws, options = {}) {
    const sessionId = randomUUID();
    const fps = Math.min(options.fps || 30, 60);
    const frameInterval = 1000 / fps;
    const quality = Math.min(Math.max(options.quality || 80, 60), 95);
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
      let lastScreenshot = null;
      let previousRaw = null; // Store previous frame for diffing

      // Calculate tile grid
      const tilesX = Math.ceil(width / this.TILE_SIZE);
      const tilesY = Math.ceil(height / this.TILE_SIZE);
      console.log(`Tile grid: ${tilesX}x${tilesY} (${tilesX * tilesY} tiles)`);

      const streamLoop = async () => {
        if (!isStreaming) {
          lastScreenshot = null;
          return;
        }

        const startTime = Date.now();

        try {
          if (page.isClosed()) {
            isStreaming = false;
            lastScreenshot = null;
            return;
          }

          const screenshot = await page.screenshot({
            type: 'png',
            encoding: 'binary',
            optimizeForSpeed: true
          });

          if (lastScreenshot) {
            lastScreenshot = null;
          }

          // Convert to raw pixels for comparison
          const currentImage = sharp(screenshot);
          const currentRaw = await currentImage
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          // Tile-based diffing optimization (after first frame)
          if (frameCount > 0 && previousRaw) {
            const changedTiles = await this.detectChangedTiles(
              currentRaw.data,
              previousRaw.data,
              width,
              height,
              tilesX,
              tilesY
            );

            // If only small portion changed, send tiles (90%+ bandwidth savings)
            if (changedTiles.length > 0 && changedTiles.length < (tilesX * tilesY) * 0.3) {
              console.log(`Sending ${changedTiles.length}/${tilesX * tilesY} changed tiles (${Math.round(changedTiles.length / (tilesX * tilesY) * 100)}%)`);
              
              const tiles = await this.compressTiles(screenshot, changedTiles, quality);

              if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                  type: 'tiles',
                  sessionId,
                  tiles,
                  frameNumber: frameCount++,
                  timestamp: startTime,
                  tileSize: this.TILE_SIZE,
                  gridSize: { x: tilesX, y: tilesY }
                }));
                errorCount = 0;
              }

              previousRaw = currentRaw;
              lastScreenshot = screenshot;

              if (frameCount % 50 === 0 && global.gc) global.gc();

              const processingTime = Date.now() - startTime;
              const nextDelay = Math.max(5, frameInterval - processingTime);

              if (isStreaming) {
                setTimeout(streamLoop, nextDelay);
              } else {
                lastScreenshot = null;
                previousRaw = null;
              }
              return;
            }
          }

          // Full frame (first frame or major changes > 30%)
          const optimizedImage = await sharp(screenshot)
            .resize(width, height, {
              fit: 'inside',
              withoutEnlargement: true,
              fastShrinkOnLoad: true,
              kernel: 'nearest'
            })
            .webp({
              quality,
              effort: 0,
              lossless: false,
              nearLossless: false,
              smartSubsample: true,
              preset: 'picture'
            })
            .toBuffer();

          previousRaw = currentRaw;
          lastScreenshot = screenshot;

          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'frame',
              sessionId,
              frame: optimizedImage.toString('base64'),
              frameNumber: frameCount++,
              timestamp: startTime,
              format: 'webp'
            }));
            
            errorCount = 0;
          }

          if (frameCount % 50 === 0 && global.gc) {
            global.gc();
          }

          const processingTime = Date.now() - startTime;
          const nextDelay = Math.max(5, frameInterval - processingTime);

          if (isStreaming) {
            setTimeout(streamLoop, nextDelay);
          } else {
            lastScreenshot = null;
            previousRaw = null;
          }
        } catch (error) {
          errorCount++;
          
          if (error.message.includes('closed') || error.message.includes('Target closed')) {
            console.log('Page closed, stopping stream');
            isStreaming = false;
            lastScreenshot = null;
            previousRaw = null;
            return;
          }
          
          console.error(`Streaming error (${errorCount}/${maxErrors}):`, error.message);
          console.error('Error stack:', error.stack);
          
          if (errorCount >= maxErrors) {
            console.error(`Too many errors, stopping stream ${sessionId}`);
            isStreaming = false;
            lastScreenshot = null;
            previousRaw = null;
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Stream error: ${error.message}`
              }));
            }
            return;
          }
          
          // Clean up on error
          if (lastScreenshot) {
            lastScreenshot = null;
          }
          if (previousRaw) {
            previousRaw = null;
          }
          
          if (isStreaming) {
            setTimeout(streamLoop, frameInterval * 2);
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

  async detectChangedTiles(currentData, previousData, width, height, tilesX, tilesY) {
    const changedTiles = [];
    const channels = 4; // RGBA
    const threshold = 0.1; // 10% pixel difference threshold

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const tileX = tx * this.TILE_SIZE;
        const tileY = ty * this.TILE_SIZE;
        const tileWidth = Math.min(this.TILE_SIZE, width - tileX);
        const tileHeight = Math.min(this.TILE_SIZE, height - tileY);

        // Fast pixel comparison using sampling
        let diffPixels = 0;
        const sampleRate = 4; // Check every 4th pixel for speed
        const totalSamples = Math.ceil(tileWidth / sampleRate) * Math.ceil(tileHeight / sampleRate);

        for (let y = 0; y < tileHeight; y += sampleRate) {
          for (let x = 0; x < tileWidth; x += sampleRate) {
            const px = tileX + x;
            const py = tileY + y;
            const offset = (py * width + px) * channels;

            // Compare RGB values (skip alpha)
            const rDiff = Math.abs(currentData[offset] - previousData[offset]);
            const gDiff = Math.abs(currentData[offset + 1] - previousData[offset + 1]);
            const bDiff = Math.abs(currentData[offset + 2] - previousData[offset + 2]);

            if (rDiff > 10 || gDiff > 10 || bDiff > 10) {
              diffPixels++;
            }
          }
        }

        // If more than threshold% pixels changed, mark tile as changed
        if (diffPixels / totalSamples > threshold) {
          changedTiles.push({ x: tileX, y: tileY, width: tileWidth, height: tileHeight });
        }
      }
    }

    return changedTiles;
  }

  async compressTiles(screenshot, tiles, quality) {
    const compressedTiles = await Promise.all(
      tiles.map(async (tile) => {
        try {
          const tileImage = await sharp(screenshot)
            .extract({
              left: tile.x,
              top: tile.y,
              width: tile.width,
              height: tile.height
            })
            .webp({
              quality,
              effort: 0,
              lossless: false,
              smartSubsample: true,
              preset: 'picture'
            })
            .toBuffer();

          return {
            x: tile.x,
            y: tile.y,
            width: tile.width,
            height: tile.height,
            data: tileImage.toString('base64')
          };
        } catch (error) {
          console.error(`Failed to compress tile at ${tile.x},${tile.y}:`, error.message);
          return null;
        }
      })
    );

    // Filter out failed tiles
    return compressedTiles.filter(tile => tile !== null);
  }
}
