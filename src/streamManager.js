import { randomUUID } from 'crypto';

const MAX_WIDTH = 1920, MAX_HEIGHT = 1080, MAX_BUFFERED_BYTES = 64 * 1024, START_TIMEOUT_MS = 45_000, STREAM_FPS = 30;
// Half a vCPU can encode roughly this many pixels per frame at the target rate.
// Capture is scaled to fit the budget, then quality adapts around it.
const PIXEL_BUDGET = 420_000, MIN_QUALITY = 30, MAX_QUALITY = 85, DEFAULT_QUALITY = 60, TUNE_INTERVAL_MS = 2_000;
const DEBUG = process.env.DEBUG_STREAM === '1';

// Matched inside the browser, so blocked requests never cost a round trip to Node.
const BLOCKED_URLS = [
  '*doubleclick.net*', '*google-analytics.com*', '*googlesyndication.com*', '*googletagmanager.com*',
  '*googletagservices.com*', '*adservice.google.*', '*connect.facebook.net*', '*facebook.com/tr*',
  '*adsystem*', '*/advertising/*', '*hotjar*', '*mixpanel*', '*segment.io*', '*sentry.io*',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
  '*.mp4', '*.webm', '*.ogv', '*.mp3', '*.wav', '*.m4a', '*.mov'
];

const log = (message, details = '') => console.log(`[RBR] ${message}${details ? ` ${details}` : ''}`);
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

  async configurePage(page, settings) {
    const cdp = await page.target().createCDPSession();
    await Promise.all([
      page.setUserAgent(settings.isMobile
        ? 'Mozilla/5.0 (Linux; Android 13; SM-G950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'),
      page.setViewport({ width: settings.width, height: settings.height, deviceScaleFactor: 1, isMobile: settings.isMobile, hasTouch: settings.isMobile }),
      page.evaluateOnNewDocument(() => {
        window.Notification = undefined;
        // document.head does not exist yet at document-start, so the animation
        // suppression has to be attached once the document element appears.
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation-duration:0s !important;transition-duration:0s !important;scroll-behavior:auto !important}';
        const attach = () => (document.head || document.documentElement)?.appendChild(style);
        if (document.documentElement) attach();
        else document.addEventListener('readystatechange', attach, { once: true });
      })
    ]);
    if (settings.isMobile) await page.setExtraHTTPHeaders({ 'Sec-CH-UA-Mobile': '?1', 'Sec-CH-UA-Platform': '"Android"', 'Accept-Language': 'en-US,en;q=0.9' });

    await cdp.send('Network.enable', { maxTotalBufferSize: 2 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 }).catch(() => {});
    await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS }).catch(() => {});
    return cdp;
  }

  tabSummary(tab) { return { id: tab.id, title: tab.title || 'New Tab', url: tab.url || 'about:blank' }; }
  sendTabState(session) {
    if (session.ws?.readyState === session.ws?.OPEN) session.ws.send(JSON.stringify({ type: 'tabState', activeTabId: session.activeTabId, tabs: [...session.tabs.values()].map((tab) => this.tabSummary(tab)) }));
  }
  async sendPageInfo(session, tab) {
    tab.url = tab.page.url(); tab.title = await tab.page.title().catch(() => '');
    if (session.ws?.readyState === session.ws?.OPEN) session.ws.send(JSON.stringify({ type: 'pageInfo', sessionId: session.id, tabId: tab.id, url: tab.url, title: tab.title }));
  }

  async startScreencast(session, tab) {
    await session.stopScreencast?.();
    let lastSentAt = 0, framesSent = 0, framesDropped = 0, ackTimer = null, ackAt = 0, encodeEma = 0;
    let quality = session.settings.quality;
    const minFrameInterval = Math.floor(1000 / STREAM_FPS);
    const applyCaptureSettings = () => tab.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth: Math.round(session.settings.width * session.settings.renderScale),
      maxHeight: Math.round(session.settings.height * session.settings.renderScale),
      everyNthFrame: 1
    });
    
    const onFrame = ({ data, metadata, sessionId: frameId }) => {
      const ack = () => { ackTimer = null; ackAt = Date.now(); tab.cdp.send('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {}); };
      
      if (session.activeTabId !== tab.id || session.ws?.readyState !== session.ws?.OPEN) { setImmediate(ack); return; }
      
      const now = Date.now();
      
      // Time from ack to delivery is how long Chrome needed to capture and encode.
      // It is the only signal that separates a CPU-bound instance from a page that
      // simply has not repainted.
      if (ackAt) encodeEma = encodeEma ? encodeEma * 0.8 + (now - ackAt) * 0.2 : now - ackAt;
      
      const waitMs = minFrameInterval - (now - lastSentAt);
      
      // Chrome only captures again once the previous frame is acknowledged, so
      // delaying the ack throttles encoding at the source instead of paying for
      // a JPEG that would immediately be discarded here.
      if (waitMs > 0 || session.ws.bufferedAmount >= MAX_BUFFERED_BYTES) {
        framesDropped++;
        ackTimer = setTimeout(ack, Math.max(waitMs, 5));
        return;
      }
      setImmediate(ack);
      
      const imageSize = Buffer.byteLength(data, 'base64');
      if (!imageSize) return;
      
      const width = Math.min(0xffff, metadata.deviceWidth || session.settings.width);
      const height = Math.min(0xffff, metadata.deviceHeight || session.settings.height);
      
      // Header and payload share one allocation; decoding straight into the tail
      // avoids an intermediate buffer and a full copy of every frame.
      const packet = Buffer.allocUnsafe(17 + imageSize);
      packet.writeUInt8(2, 0);
      packet.writeUInt32BE(session.frameNumber++, 1);
      packet.writeDoubleBE(now, 5);
      packet.writeUInt16BE(width, 13);
      packet.writeUInt16BE(height, 15);
      const written = packet.write(data, 17, 'base64');
      if (!written) return;
      
      session.ws.send(written === imageSize ? packet : packet.subarray(0, 17 + written), { binary: true, compress: false });
      lastSentAt = now;
      framesSent++;
    };
    
    tab.cdp.on('Page.screencastFrame', onFrame);
    await applyCaptureSettings();
    
    // Encoding is the scarce resource on a small instance, so quality is spent
    // only while the target frame rate is actually being met.
    const tuneTimer = setInterval(() => {
      const congested = (session.ws?.bufferedAmount || 0) > MAX_BUFFERED_BYTES / 2;
      const previous = quality;
      if (encodeEma) {
        if (congested || encodeEma > minFrameInterval * 1.6) quality = Math.max(MIN_QUALITY, quality - 6);
        else if (encodeEma < minFrameInterval * 0.8) quality = Math.min(session.settings.quality, quality + 3);
      }
      if (DEBUG) {
        const total = framesSent + framesDropped;
        log('screencast stats', `session=${session.id.slice(0, 8)} fps=${Math.round(framesSent / (TUNE_INTERVAL_MS / 1000))} dropped=${total ? Math.round((framesDropped / total) * 100) : 0}% encode=${Math.round(encodeEma)}ms q=${quality}`);
      }
      framesSent = 0; framesDropped = 0;
      if (quality !== previous) applyCaptureSettings().catch(() => {});
    }, TUNE_INTERVAL_MS);
    
    session.stopScreencast = async () => {
      clearInterval(tuneTimer);
      clearTimeout(ackTimer);
      tab.cdp.off('Page.screencastFrame', onFrame);
      await tab.cdp.send('Page.stopScreencast').catch(() => {});
    };
    
    log('screencast active', `session=${session.id.slice(0, 8)} tab=${tab.id.slice(0, 8)} ${STREAM_FPS}fps`);
  }

  async startStream(rawUrl, ws, options = {}) {
    const url = normalizeRemoteUrl(rawUrl), sessionId = randomUUID();
    log('starting stream', `session=${sessionId.slice(0, 8)} url=${url}`);
    const settings = {
      fps: STREAM_FPS, quality: clamp(options.quality, MIN_QUALITY, MAX_QUALITY, DEFAULT_QUALITY),
      width: clamp(options.width, 320, MAX_WIDTH, 1280), height: clamp(options.height, 240, MAX_HEIGHT, 720),
      isMobile: Boolean(options.isMobile),
      renderScale: 1
    };
    // Small phone viewports already fit the budget and are sent at native size;
    // only large desktop surfaces get scaled down before encoding.
    settings.renderScale = Math.min(1, Math.sqrt(PIXEL_BUDGET / (settings.width * settings.height)));
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
    session.settings.quality = clamp(changes.quality, MIN_QUALITY, MAX_QUALITY, session.settings.quality);
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
      case 'click': {
        const x = clamp(action.x, 0, settings.width, 0), y = clamp(action.y, 0, settings.height, 0);
        const button = action.button === 'right' ? 'right' : 'left', buttons = button === 'right' ? 2 : 1;
        // Not awaited: CDP preserves send order on a session, and blocking on the
        // round trip is what makes a remote click feel detached from the tap.
        tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }).catch(() => {});
        tab.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 }).catch(() => {});
        tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 }).catch(() => {});
        break;
      }
      case 'scroll': {
        // Swipes can produce dozens of events. Merge them server-side and apply
        // once per tick, rather than serializing page.evaluate calls behind one
        // another and making scrolling feel delayed.
        session.pendingScroll += clamp(action.deltaY, -2_000, 2_000, 0);
        if (!session.scrollScheduled) {
          session.scrollScheduled = true;
          setImmediate(() => {
            const delta = clamp(session.pendingScroll, -4_000, 4_000, 0);
            session.pendingScroll = 0; session.scrollScheduled = false;
            if (!delta) return;
            // A real wheel event also scrolls whatever nested container is under
            // the cursor, which window.scrollBy cannot do.
            tab.cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel', x: Math.round(settings.width / 2), y: Math.round(settings.height / 2),
              deltaX: 0, deltaY: delta, pointerType: 'mouse'
            }).catch(() => {});
          });
        }
        break;
      }
      case 'type': if (typeof action.text === 'string' && action.text.length <= 512) tab.cdp.send('Input.insertText', { text: action.text }).catch(() => {}); break;
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
