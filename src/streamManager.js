import { randomUUID } from 'crypto';

const MAX_WIDTH = 1920, MAX_HEIGHT = 1080, MAX_BUFFERED_BYTES = 64 * 1024, START_TIMEOUT_MS = 45_000, STREAM_FPS = 30;
const DEBUG = process.env.DEBUG_STREAM === '1';
const log = (message, details = '') => console.log(`[RBR] ${message}${details ? ` ${details}` : ''}`);
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

// Ultra-efficient frame buffer pool with pre-allocated buffers
class FrameBufferPool {
  constructor(maxBuffers = 8) {
    this.pool = [];
    this.maxBuffers = maxBuffers;
    this.headerPool = [];
    this.maxHeaders = 3;
  }
  
  acquireHeader() {
    return this.headerPool.pop() || Buffer.allocUnsafe(17);
  }
  
  releaseHeader(buffer) {
    if (this.headerPool.length < this.maxHeaders) {
      this.headerPool.push(buffer);
    }
  }
  
  acquire(size) {
    const buffer = this.pool.find(b => b.length >= size);
    if (buffer) {
      this.pool = this.pool.filter(b => b !== buffer);
      return buffer;
    }
    return Buffer.allocUnsafe(size);
  }
  
  release(buffer) {
    if (this.pool.length < this.maxBuffers && buffer.length <= 256 * 1024) {
      this.pool.push(buffer);
    }
  }
  
  clear() {
    this.pool = [];
    this.headerPool = [];
  }
}

const frameBufferPool = new FrameBufferPool();

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

  async configurePage(page, settings) {
    await page.setUserAgent(settings.isMobile
      ? 'Mozilla/5.0 (Linux; Android 13; SM-G950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: settings.width, height: settings.height, deviceScaleFactor: 1, isMobile: settings.isMobile, hasTouch: settings.isMobile });
    if (settings.isMobile) await page.setExtraHTTPHeaders({ 'Sec-CH-UA-Mobile': '?1', 'Sec-CH-UA-Platform': '"Android"', 'Accept-Language': 'en-US,en;q=0.9' });
    
    // More aggressive blocking for performance
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType(), requestUrl = request.url().toLowerCase();
      // Block fonts, ads, analytics, and unnecessary media
      const blocked = ['font', 'media', 'websocket'].includes(type) || 
        /(?:doubleclick|google-analytics|\/analytics|\/tracking|facebook\.com\/tr|adsystem|googlesyndication|adservice|ads\.|advertising)/.test(requestUrl);
      (blocked ? request.abort() : request.continue()).catch(() => {});
    });
    
    // Performance optimizations
    await page.evaluateOnNewDocument(() => { 
      window.Notification = undefined;
      // Disable animations for performance
      const style = document.createElement('style');
      style.textContent = '* { animation-duration: 0s !important; transition-duration: 0s !important; }';
      document.head?.appendChild(style);
    });
    
    return page.target().createCDPSession();
  }

  tabSummary(tab) { return { id: tab.id, title: tab.title || 'New Tab', url: tab.url || 'about:blank' }; }
  sendTabState(session) {
    if (session.ws.readyState === session.ws.OPEN) session.ws.send(JSON.stringify({ type: 'tabState', activeTabId: session.activeTabId, tabs: [...session.tabs.values()].map((tab) => this.tabSummary(tab)) }));
  }
  async sendPageInfo(session, tab) {
    tab.url = tab.page.url(); tab.title = await tab.page.title().catch(() => '');
    if (session.ws.readyState === session.ws.OPEN) session.ws.send(JSON.stringify({ type: 'pageInfo', sessionId: session.id, tabId: tab.id, url: tab.url, title: tab.title }));
  }

  async startScreencast(session, tab) {
    await session.stopScreencast?.();
    let lastSentAt = 0, framesSent = 0, framesDropped = 0;
    const minFrameInterval = Math.floor(1000 / STREAM_FPS);
    
    const onFrame = ({ data, metadata, sessionId: frameId }) => {
      // Acknowledge immediately to prevent Chrome from buffering
      setImmediate(() => tab.cdp.send('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {}));
      
      if (session.activeTabId !== tab.id || session.ws.readyState !== session.ws.OPEN) return;
      
      const now = Date.now();
      
      // Ultra-aggressive backpressure and frame rate control
      if (session.ws.bufferedAmount >= MAX_BUFFERED_BYTES || now - lastSentAt < minFrameInterval) {
        framesDropped++;
        return;
      }
      
      const image = Buffer.from(data, 'base64');
      if (!image.length) return;
      
      const width = Math.min(0xffff, Math.round((metadata.deviceWidth || session.settings.width) * session.settings.renderScale));
      const height = Math.min(0xffff, Math.round((metadata.deviceHeight || session.settings.height) * session.settings.renderScale));
      
      // Use pooled header buffer
      const header = frameBufferPool.acquireHeader();
      header.writeUInt8(2, 0); 
      header.writeUInt32BE(session.frameNumber++, 1); 
      header.writeDoubleBE(now, 5);
      header.writeUInt16BE(width, 13); 
      header.writeUInt16BE(height, 15);
      
      // Send frame
      try {
        session.ws.send(Buffer.concat([header, image]), { binary: true, compress: false });
        lastSentAt = now;
        framesSent++;
      } finally {
        frameBufferPool.releaseHeader(header);
      }
      
      if (DEBUG && session.frameNumber % STREAM_FPS === 0) {
        const dropRate = framesDropped > 0 ? Math.round((framesDropped / (framesSent + framesDropped)) * 100) : 0;
        log('screencast stats', `session=${session.id.slice(0, 8)} fps=${Math.round(framesSent / (now - (lastSentAt - (framesSent * minFrameInterval))) * 1000)} dropped=${dropRate}% size=${Math.round(image.length / 1024)}KB buffer=${Math.round(session.ws.bufferedAmount / 1024)}KB`);
        framesSent = 0;
        framesDropped = 0;
      }
    };
    
    tab.cdp.on('Page.screencastFrame', onFrame);
    
    // Optimized screencast settings for better performance
    await tab.cdp.send('Page.startScreencast', {
      format: 'jpeg', 
      quality: session.settings.quality,
      maxWidth: Math.round(session.settings.width * session.settings.renderScale),
      maxHeight: Math.round(session.settings.height * session.settings.renderScale),
      everyNthFrame: 1
    });
    
    session.stopScreencast = async () => {
      tab.cdp.off('Page.screencastFrame', onFrame);
      await tab.cdp.send('Page.stopScreencast').catch(() => {});
    };
    
    log('screencast active', `session=${session.id.slice(0, 8)} tab=${tab.id.slice(0, 8)} ${STREAM_FPS}fps`);
  }

  async startStream(rawUrl, ws, options = {}) {
    const url = normalizeRemoteUrl(rawUrl), sessionId = randomUUID();
    log('starting stream', `session=${sessionId.slice(0, 8)} url=${url}`);
    const settings = {
      // Increased to 30 FPS for smoother experience
      fps: STREAM_FPS, quality: clamp(options.quality, 28, 55, 38),
      width: clamp(options.width, 320, MAX_WIDTH, 1280), height: clamp(options.height, 240, MAX_HEIGHT, 720),
      isMobile: Boolean(options.isMobile), 
      // Reduced render scale for better performance
      renderScale: Boolean(options.isMobile) ? 0.7 : 0.55
    };
    const send = (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    let browser, page;
    try {
      send({ type: 'progress', progress: 5, message: 'Acquiring browser...', subtext: 'Initializing' });
      browser = await this.browserPool.acquire();
      page = await browser.newPage();
      
      // Performance optimization: disable unnecessary browser features
      const cdp = await this.configurePage(page, settings);
      
      // Disable images for faster loading (optional - comment out if you need images)
      // await page.setRequestInterception(true);
      
      send({ type: 'progress', progress: 30, message: 'Navigating to page...', subtext: 'Loading content' });
      await Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('The browser took too long to start.')), START_TIMEOUT_MS))
      ]).catch((error) => { if (page.url() === 'about:blank') throw error; });
      
      const firstTab = { id: randomUUID(), page, cdp, url: page.url(), title: await page.title().catch(() => '') };
      send({ type: 'progress', progress: 95, message: 'Streaming started', subtext: 'Ready' });
      
      const session = { 
        id: sessionId, browser, ws, settings, 
        tabs: new Map([[firstTab.id, firstTab]]), 
        activeTabId: firstTab.id, 
        frameNumber: 0, 
        pendingScroll: 0, 
        scrollScheduled: false,
        audioEnabled: Boolean(options.enableAudio),
        stop: async () => { 
          await session.stopScreencast?.(); 
          await session.stopAudio?.();
        } 
      };
      
      this.sessions.set(sessionId, session);
      await this.sendPageInfo(session, firstTab);
      this.sendTabState(session);
      send({ type: 'progress', progress: 100, message: 'Stream ready', subtext: 'Connected' });
      log('stream ready', `session=${sessionId.slice(0, 8)} ${settings.width}x${settings.height} ${STREAM_FPS}fps audio=${session.audioEnabled}`);
      
      await this.startScreencast(session, firstTab);
      
      // Start audio streaming if enabled
      if (session.audioEnabled) {
        await this.startAudioCapture(session, firstTab);
      }
      
      return sessionId;
    } catch (error) {
      this.sessions.delete(sessionId);
      if (page) await page.close().catch(() => {});
      if (browser) this.browserPool.release(browser);
      throw error;
    }
  }
  
  async startAudioCapture(session, tab) {
    try {
      // Enable audio domain in CDP
      await tab.cdp.send('Page.enable');
      
      // Note: Audio capture requires additional setup and is experimental
      // This is a placeholder for future audio streaming implementation
      log('audio capture', `session=${session.id.slice(0, 8)} - audio streaming prepared`);
      
      session.stopAudio = async () => {
        // Cleanup audio resources
      };
    } catch (error) {
      log('audio capture failed', error.message);
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
    await session.stop(); this.sessions.delete(sessionId); log('stream stopped', `session=${sessionId.slice(0, 8)}`);
    await Promise.all([...session.tabs.values()].map((tab) => tab.page.close().catch(() => {})));
    this.browserPool.release(session.browser);
    // Clean up session memory
    session.tabs.clear();
    session.ws = null;
  }
  async createTab(sessionId, rawUrl = 'https://www.google.com') {
    const session = this.sessions.get(sessionId); if (!session) throw new Error('Unknown stream session.');
    if (session.tabs.size >= 3) throw new Error('Close a tab before opening another one.');
    log('creating tab', `session=${sessionId.slice(0, 8)}`);
    const page = await session.browser.newPage(), cdp = await this.configurePage(page, session.settings);
    const tab = { id: randomUUID(), page, cdp, url: 'about:blank', title: 'New Tab' };
    session.tabs.set(tab.id, tab); session.activeTabId = tab.id;
    await page.goto(normalizeRemoteUrl(rawUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await this.sendPageInfo(session, tab); this.sendTabState(session); await this.startScreencast(session, tab);
  }
  async switchTab(sessionId, tabId) {
    const session = this.sessions.get(sessionId), tab = session?.tabs.get(tabId);
    if (!tab) throw new Error('Unknown tab.');
    session.activeTabId = tabId; log('switched tab', `session=${sessionId.slice(0, 8)} tab=${tabId.slice(0, 8)}`); await this.sendPageInfo(session, tab); this.sendTabState(session); await this.startScreencast(session, tab);
  }
  async closeTab(sessionId, tabId) {
    const session = this.sessions.get(sessionId), tab = session?.tabs.get(tabId);
    if (!tab) throw new Error('Unknown tab.');
    if (session.tabs.size === 1) {
      await tab.page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await this.sendPageInfo(session, tab); return;
    }
    const tabIds = [...session.tabs.keys()], closingIndex = tabIds.indexOf(tabId);
    const wasActive = session.activeTabId === tabId;
    session.tabs.delete(tabId); await tab.page.close().catch(() => {});
    if (wasActive) session.activeTabId = tabIds[Math.max(0, closingIndex - 1)];
    const activeTab = session.tabs.get(session.activeTabId);
    await this.sendPageInfo(session, activeTab); this.sendTabState(session);
    if (wasActive) await this.startScreencast(session, activeTab);
  }
  async handleInteraction(sessionId, action) {
    const session = this.sessions.get(sessionId); if (!session) throw new Error('Unknown stream session.');
    const tab = session.tabs.get(session.activeTabId); if (!tab) throw new Error('No active tab.');
    const { page } = tab, { ws, settings } = session;
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
          // Immediate execution for better responsiveness
          setImmediate(async () => {
            const delta = clamp(session.pendingScroll, -4_000, 4_000, 0);
            session.pendingScroll = 0; session.scrollScheduled = false;
            if (!page.isClosed() && delta) await page.evaluate((amount) => window.scrollBy(0, amount), delta).catch(() => {});
          });
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
        await this.sendPageInfo(session, tab); this.sendTabState(session);
        break;
      default: throw new Error('Unsupported interaction.');
    }
  }
  async cleanup() { await Promise.all([...this.sessions.keys()].map((id) => this.stopStream(id))); }
}
