import { randomUUID } from 'crypto';

const MAX_WIDTH = 1920, MAX_HEIGHT = 1080, MAX_BUFFERED_BYTES = 512 * 1024, START_TIMEOUT_MS = 45_000, STREAM_FPS = 24;
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

export function normalizeRemoteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2_048) throw new Error('Enter a valid URL.');
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new Error('Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free HTTP and HTTPS URLs are allowed.');
  }
  return url.toString();
}

export class StreamManager {
  constructor(browserPool) { this.browserPool = browserPool; this.sessions = new Map(); }

  async startStream(rawUrl, ws, options = {}) {
    const url = normalizeRemoteUrl(rawUrl), sessionId = randomUUID();
    const settings = {
      // Keep the capture loop at one stable 24-FPS target. Actual output can
      // only be lower if the host cannot encode a frame inside 41.7ms.
      fps: STREAM_FPS, quality: clamp(options.quality, 35, 60, 46),
      width: clamp(options.width, 320, MAX_WIDTH, 1280), height: clamp(options.height, 240, MAX_HEIGHT, 720),
      isMobile: Boolean(options.isMobile), renderScale: Boolean(options.isMobile) ? 0.8 : 0.65
    };
    const send = (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    let browser, page;
    try {
      send({ type: 'progress', progress: 5, message: 'Acquiring browser...', subtext: 'Initializing' });
      browser = await this.browserPool.acquire();
      page = await browser.newPage();
      await page.setUserAgent(settings.isMobile
        ? 'Mozilla/5.0 (Linux; Android 13; SM-G950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: settings.width, height: settings.height, deviceScaleFactor: 1, isMobile: settings.isMobile, hasTouch: settings.isMobile });
      if (settings.isMobile) {
        await page.setExtraHTTPHeaders({
          'Sec-CH-UA-Mobile': '?1',
          'Sec-CH-UA-Platform': '"Android"',
          'Accept-Language': 'en-US,en;q=0.9'
        });
      }
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const type = request.resourceType(), requestUrl = request.url().toLowerCase();
        // Do not block media: video segments are required for YouTube and other
        // streaming sites. Fonts and known telemetry remain safe to skip.
        const blocked = type === 'font' || /(?:doubleclick|google-analytics|\/analytics|\/tracking|facebook\.com\/tr|adsystem)/.test(requestUrl);
        (blocked ? request.abort() : request.continue()).catch(() => {});
      });
      await page.evaluateOnNewDocument(() => { window.Notification = undefined; });
      send({ type: 'progress', progress: 30, message: 'Navigating to page...', subtext: 'Loading content' });
      await Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('The browser took too long to start.')), START_TIMEOUT_MS))
      ]).catch((error) => { if (page.url() === 'about:blank') throw error; });
      send({ type: 'pageInfo', sessionId, url: page.url(), title: await page.title().catch(() => '') });
      send({ type: 'progress', progress: 95, message: 'Streaming started', subtext: 'Ready' });
      const cdp = await page.target().createCDPSession();
      let active = true, frameNumber = 0, consecutiveErrors = 0;
      const streamLoop = async () => {
        if (!active || page.isClosed()) return;
        const startedAt = Date.now();
        try {
          // Keep latency bounded: discard frames while the network is behind.
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES) {
            // Chrome captures directly at the smaller scale. This avoids a
            // full-size image buffer and expensive server-side resizing.
            let image, sourceWidth, sourceHeight;
            try {
              const capture = await cdp.send('Page.captureScreenshot', {
                // JPEG is materially faster to encode than WebP on small shared
                // CPUs. At this scale/quality it remains compact and decodes in
                // every browser without a compatibility fallback.
                format: 'jpeg', quality: settings.quality, optimizeForSpeed: true,
                clip: { x: 0, y: 0, width: settings.width, height: settings.height, scale: settings.renderScale },
                captureBeyondViewport: false
              });
              image = Buffer.from(capture.data, 'base64');
              sourceWidth = Math.round(settings.width * settings.renderScale);
              sourceHeight = Math.round(settings.height * settings.renderScale);
              if (image.length === 0) throw new Error('Empty CDP screenshot');
            } catch (captureError) {
              // Some managed Chromium builds reject scaled CDP captures. The
              // normal Puppeteer path is slower, but it keeps the stream alive.
              console.warn(`Scaled capture unavailable for ${sessionId}: ${captureError.message}`);
              image = await page.screenshot({ type: 'jpeg', quality: settings.quality, optimizeForSpeed: true });
              sourceWidth = settings.width;
              sourceHeight = settings.height;
            }
            const header = Buffer.allocUnsafe(17);
            header.writeUInt8(2, 0); header.writeUInt32BE(frameNumber++, 1); header.writeDoubleBE(startedAt, 5);
            header.writeUInt16BE(sourceWidth, 13); header.writeUInt16BE(sourceHeight, 15);
            ws.send(Buffer.concat([header, image]), { binary: true, compress: false });
          }
          consecutiveErrors = 0;
        } catch (error) {
          if (/closed|Target closed/i.test(error.message)) return;
          if (++consecutiveErrors >= 8) { active = false; send({ type: 'error', message: 'Stream stopped after repeated capture failures.' }); return; }
        }
        setTimeout(streamLoop, Math.max(0, (1000 / STREAM_FPS) - (Date.now() - startedAt)));
      };
      this.sessions.set(sessionId, { browser, page, ws, settings, pendingScroll: 0, scrollScheduled: false, stop: () => { active = false; } });
      send({ type: 'progress', progress: 100, message: 'Stream ready', subtext: 'Connected' });
      streamLoop();
      return sessionId;
    } catch (error) {
      if (page) await page.close().catch(() => {});
      if (browser) this.browserPool.release(browser);
      throw error;
    }
  }

  updateStream(sessionId, changes = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown stream session.');
    session.settings.fps = STREAM_FPS;
    session.settings.quality = clamp(changes.quality, 35, 60, session.settings.quality);
  }
  async stopStream(sessionId) {
    const session = this.sessions.get(sessionId); if (!session) return;
    session.stop(); this.sessions.delete(sessionId); await session.page.close().catch(() => {}); this.browserPool.release(session.browser);
  }
  async handleInteraction(sessionId, action) {
    const session = this.sessions.get(sessionId); if (!session) throw new Error('Unknown stream session.');
    const { page, ws, settings } = session;
    if (!action || typeof action.type !== 'string') throw new Error('Invalid interaction.');
    switch (action.type) {
      case 'click': await page.mouse.click(clamp(action.x, 0, settings.width, 0), clamp(action.y, 0, settings.height, 0), { button: action.button === 'right' ? 'right' : 'left' }); break;
      case 'scroll': {
        // Swipes can produce dozens of events. Merge them server-side and apply
        // once per tick, rather than serializing page.evaluate calls behind one
        // another and making scrolling feel delayed.
        session.pendingScroll += clamp(action.deltaY, -2_000, 2_000, 0);
        if (!session.scrollScheduled) {
          session.scrollScheduled = true;
          setTimeout(async () => {
            const delta = clamp(session.pendingScroll, -4_000, 4_000, 0);
            session.pendingScroll = 0; session.scrollScheduled = false;
            if (!page.isClosed() && delta) await page.evaluate((amount) => window.scrollBy(0, amount), delta).catch(() => {});
          }, 0);
        }
        break;
      }
      case 'type': if (typeof action.text === 'string' && action.text.length <= 512) await page.keyboard.type(action.text); break;
      case 'key': if (typeof action.key === 'string' && /^[A-Za-z0-9+_-]{1,32}$/.test(action.key)) await page.keyboard.press(action.key); break;
      case 'navigate':
        if (action.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        else if (action.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        else if (action.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        else if (action.action === 'goto') await page.goto(normalizeRemoteUrl(action.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        else throw new Error('Unsupported navigation.');
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pageInfo', sessionId, url: page.url(), title: await page.title().catch(() => '') }));
        break;
      default: throw new Error('Unsupported interaction.');
    }
  }
  async cleanup() { await Promise.all([...this.sessions.keys()].map((id) => this.stopStream(id))); }
}
