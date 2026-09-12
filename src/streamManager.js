import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

const MAX_WIDTH = 1920, MAX_HEIGHT = 1080, MAX_BUFFERED_BYTES = 192 * 1024, START_TIMEOUT_MS = 45_000, STREAM_FPS = 30;
// Half a vCPU can encode roughly this many pixels per frame at the target rate.
// Capture is scaled to fit the budget, then quality adapts around it.
const PIXEL_BUDGET = 620_000, MIN_QUALITY = 30, MAX_QUALITY = 85, DEFAULT_QUALITY = 60, TUNE_INTERVAL_MS = 1_000;
// Adaptive frame pacing: 30fps down to 12fps, then capture downscale to 60%.
const MIN_FRAME_INTERVAL = Math.floor(1000 / STREAM_FPS), MAX_FRAME_INTERVAL = Math.floor(1000 / 12), MIN_SCALE = 0.5;
const DEBUG = process.env.DEBUG_STREAM === '1';

// Chrome mixes every tab's output into one PulseAudio sink; ffmpeg reads that
// sink's monitor source and re-encodes it to Opus for the WebSocket.
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const AUDIO_SOURCE = process.env.PULSE_AUDIO_SOURCE || 'virtual_speaker.monitor';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '32k';
const AUDIO_MIME_TYPE = 'audio/webm; codecs="opus"';

// Matched inside the browser, so blocked requests never cost a round trip to Node.
// Trackers and fonts only: fonts are invisible at stream quality and trackers
// are pure overhead. Media is NOT blocked by default because these globs match
// anywhere in the URL, so `*.mp4` also kills MSE segments like
// `cdn.example/v/abc.mp4?bytestart=0`, breaking every video player (and audio).
const BLOCKED_URLS = [
  '*doubleclick.net*', '*google-analytics.com*', '*googlesyndication.com*', '*googletagmanager.com*',
  '*googletagservices.com*', '*adservice.google.*', '*connect.facebook.net*', '*facebook.com/tr*',
  '*adsystem*', '*/advertising/*', '*hotjar*', '*mixpanel*', '*segment.io*', '*sentry.io*',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot'
];
// Opt-in for bandwidth-starved deployments where video is not wanted.
if (process.env.BLOCK_MEDIA === '1') BLOCKED_URLS.push('*.mp4', '*.webm', '*.ogv', '*.mp3', '*.wav', '*.m4a', '*.mov', '*.m3u8', '*.ts');

const log = (message, details = '') => console.log(`[RBR] ${message}${details ? ` ${details}` : ''}`);
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

// Chrome commits the frame to the failed URL before rejecting navigation, so
// `page.url()` alone can't tell a real failure (cert/DNS/refused) apart from a
// page that is just slow to finish loading. ERR_ABORTED is excluded because it
// commonly fires for benign cases (downloads, client-side redirects).
const isFatalNavigationError = (error) => {
  const message = error?.message || '';
  return /net::ERR_/.test(message) && !message.includes('ERR_ABORTED');
};
const NAV_ERROR_MESSAGES = {
  ERR_CERT_COMMON_NAME_INVALID: "This site's security certificate does not match its domain name.",
  ERR_CERT_AUTHORITY_INVALID: "This site's security certificate is not trusted.",
  ERR_CERT_DATE_INVALID: "This site's security certificate has expired or is not yet valid.",
  ERR_CERT_REVOKED: "This site's security certificate has been revoked.",
  ERR_NAME_NOT_RESOLVED: 'This domain name could not be found. Check the URL for typos.',
  ERR_CONNECTION_REFUSED: 'The server refused to connect.',
  ERR_CONNECTION_TIMED_OUT: 'The connection to the server timed out.',
  ERR_CONNECTION_CLOSED: 'The connection was closed before the page could load.',
  ERR_CONNECTION_RESET: 'The connection was reset while the page was loading.',
  ERR_INTERNET_DISCONNECTED: 'No internet connection is available.',
  ERR_TOO_MANY_REDIRECTS: 'This page has a redirect loop.',
  ERR_ADDRESS_UNREACHABLE: 'The server could not be reached.',
};
function describeNavigationError(error) {
  const code = /ERR_[A-Z_]+/.exec(error?.message || '')?.[0];
  return new Error(code && NAV_ERROR_MESSAGES[code] ? `${NAV_ERROR_MESSAGES[code]} (${code})` : 'The page could not be loaded.');
}

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
  constructor(browserPool) { this.browserPool = browserPool; this.sessions = new Map(); this.audioStatus = { available: false, reason: 'Audio self-test has not run yet.' }; }

  // Runs once at boot. A 0.3s capture from the monitor source proves every link
  // - ffmpeg binary, PulseAudio daemon, the virtual sink - in one shot, so the
  // failure shows up in the deploy log instead of as silence for the user.
  async probeAudio() {
    const run = (args, timeoutMs) => new Promise((resolve) => {
      let proc, stderr = '';
      try { proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (error) { return resolve({ code: null, stderr: error.message }); }
      const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-600); });
      proc.once('error', (error) => { clearTimeout(timer); resolve({ code: null, stderr: error.code === 'ENOENT' ? 'ffmpeg is not installed' : error.message }); });
      proc.once('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
    const version = await run(['-hide_banner', '-version'], 5_000);
    if (version.code !== 0) { this.audioStatus = { available: false, reason: `ffmpeg unavailable: ${version.stderr.trim().split('\n')[0] || 'not found'}` }; }
    else {
      const capture = await run(['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', AUDIO_SOURCE, '-t', '0.3', '-f', 'null', '-'], 8_000);
      this.audioStatus = capture.code === 0
        ? { available: true, reason: '' }
        : { available: false, reason: `PulseAudio source "${AUDIO_SOURCE}" unreadable: ${capture.stderr.trim().split('\n').pop() || 'capture failed'}` };
    }
    log('audio self-test', this.audioStatus.available ? `ok source=${AUDIO_SOURCE}` : this.audioStatus.reason);
    return this.audioStatus;
  }

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

    // Network.enable is only needed for setBlockedURLs. Leave the response-body
    // buffer at zero: we never read bodies, and a capped buffer makes DevTools
    // start evicting/truncating large media responses under memory pressure.
    await cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => {});
    await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS }).catch(() => {});
    // Headless pages report themselves as hidden/unfocused, so sites pause video,
    // throttle rAF loops and skip repaints - and the screencast only emits a
    // frame when the compositor repaints. Pretend the tab is a focused, visible
    // foreground window; touch emulation also makes mobile sites bind tap handlers.
    await Promise.all([
      cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      cdp.send('Page.setWebLifecycleState', { state: 'active' }),
      settings.isMobile ? cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }) : Promise.resolve()
    ].map((p) => p.catch(() => {})));
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
    if (session.screencastSuspended) return;
    let lastSentAt = 0, framesSent = 0, framesDropped = 0, ackTimer = null, ackAt = 0, encodeEma = 0;
    let quality = session.settings.quality, scale = 1, minFrameInterval = MIN_FRAME_INTERVAL;
    const applyCaptureSettings = () => tab.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth: Math.round(session.settings.width * session.settings.renderScale * scale),
      maxHeight: Math.round(session.settings.height * session.settings.renderScale * scale),
      everyNthFrame: 1,
      // The CDP default permits three frames to wait for acknowledgement. That
      // silently turns a slow client into a multi-frame latency queue. One
      // in-flight frame plus Chrome's newest-frame replacement keeps the stream
      // live rather than faithfully delivering stale images.
      maxFramesInFlight: 1,
      sendLastFrame: true
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
      
      // Pre-decode base64 once into a binary buffer; Buffer.from is significantly
      // faster than packet.write(data, offset, 'base64') which re-parses per character.
      const jpegBuf = Buffer.from(data, 'base64');
      if (!jpegBuf.length) return;
      
      const width = Math.min(0xffff, metadata.deviceWidth || session.settings.width);
      const height = Math.min(0xffff, metadata.deviceHeight || session.settings.height);
      
      const packet = Buffer.allocUnsafe(17 + jpegBuf.length);
      packet.writeUInt8(2, 0);
      packet.writeUInt32BE(session.frameNumber++, 1);
      packet.writeDoubleBE(now, 5);
      packet.writeUInt16BE(width, 13);
      packet.writeUInt16BE(height, 15);
      jpegBuf.copy(packet, 17);
      
      session.ws.send(packet, { binary: true, compress: false });
      lastSentAt = now;
      framesSent++;
    };
    
    tab.cdp.on('Page.screencastFrame', onFrame);
    await applyCaptureSettings();
    
    // JPEG encode cost is per pixel, so quality barely moves CPU load; it is a
    // bandwidth lever only. When Chrome cannot deliver frames within budget the
    // real fixes are a lower frame rate, then fewer pixels - in that order, since
    // a steady 15fps reads better than a smeared 30fps.
    const tuneTimer = setInterval(() => {
      const congested = (session.ws?.bufferedAmount || 0) > MAX_BUFFERED_BYTES / 2;
      const prevQuality = quality, prevScale = scale;
      if (encodeEma) {
        const overloaded = encodeEma > minFrameInterval * 1.25, relaxed = encodeEma < minFrameInterval * 0.5;
        if (overloaded) {
          if (minFrameInterval < MAX_FRAME_INTERVAL) minFrameInterval = Math.min(MAX_FRAME_INTERVAL, Math.round(minFrameInterval * 1.25));
          else scale = Math.max(MIN_SCALE, Math.round((scale - 0.1) * 10) / 10);
        } else if (relaxed) {
          if (scale < 1) scale = Math.min(1, Math.round((scale + 0.1) * 10) / 10);
          else if (minFrameInterval > MIN_FRAME_INTERVAL) minFrameInterval = Math.max(MIN_FRAME_INTERVAL, Math.round(minFrameInterval / 1.25));
        }
        if (congested) quality = Math.max(MIN_QUALITY, quality - 6);
        else if (!overloaded) quality = Math.min(session.settings.quality, quality + 5);
      }
      if (DEBUG) {
        const total = framesSent + framesDropped;
        log('screencast stats', `session=${session.id.slice(0, 8)} fps=${Math.round(framesSent / (TUNE_INTERVAL_MS / 1000))} target=${Math.round(1000 / minFrameInterval)} dropped=${total ? Math.round((framesDropped / total) * 100) : 0}% encode=${Math.round(encodeEma)}ms q=${quality} scale=${scale}`);
      }
      framesSent = 0; framesDropped = 0;
      if (quality !== prevQuality || scale !== prevScale) applyCaptureSettings().catch(() => {});
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
      try {
        await Promise.race([
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('The browser took too long to start.')), START_TIMEOUT_MS))
        ]);
      } catch (error) {
        // A slow-but-valid page can still miss our race timeout, so only a real
        // network/certificate failure (or a page that never left about:blank)
        // should abort the session.
        if (isFatalNavigationError(error)) throw describeNavigationError(error);
        if (page.url() === 'about:blank') throw error;
      }
      
      const firstTab = { id: randomUUID(), page, cdp, url: page.url(), title: await page.title().catch(() => '') };
      send({ type: 'progress', progress: 95, message: 'Streaming started', subtext: 'Ready' });
      
      const session = { 
        id: sessionId, browser, ws, settings, 
        tabs: new Map([[firstTab.id, firstTab]]), 
        activeTabId: firstTab.id, 
        frameNumber: 0, 
        pendingScroll: 0, 
        scrollScheduled: false,
        screencastSuspended: false,
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
        await this.startAudioCapture(session);
      }
      
      return sessionId;
    } catch (error) {
      this.sessions.delete(sessionId);
      if (page) await page.close().catch(() => {});
      if (browser) this.browserPool.release(browser);
      throw error;
    }
  }
  
  sendJson(session, message) {
    if (session.ws?.readyState === session.ws?.OPEN) session.ws.send(JSON.stringify(message));
  }
  failAudio(session, message) {
    session.audioEnabled = false;
    log('audio unavailable', `session=${session.id.slice(0, 8)} ${message}`);
    this.sendJson(session, { type: 'audioError', message });
  }

  async startAudioCapture(session) {
    await session.stopAudio?.();
    if (session.ws?.readyState !== session.ws?.OPEN) return;
    if (!this.audioStatus.available) { this.failAudio(session, this.audioStatus.reason); return; }
    
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', DEBUG ? 'warning' : 'error',
      '-probesize', '32', '-analyzeduration', '0',
      '-fflags', '+nobuffer+flush_packets', '-flags', 'low_delay',
      // A huge capture queue turns a short network stall into seconds of stale
      // audio. Keep just enough room for normal scheduler jitter.
      '-thread_queue_size', '32',
      // 1920 bytes = 20ms of 48kHz mono s16, matching one Opus frame exactly.
      '-f', 'pulse', '-fragment_size', '1920', '-i', AUDIO_SOURCE,
      '-ac', '1', '-ar', '48000', '-vn',
      // compression_level 3 is ~1/3 the CPU of the default 10 for speech/music
      // at this bitrate; the sink is already mono 48k so no resampling happens.
      '-c:a', 'libopus', '-b:a', AUDIO_BITRATE, '-compression_level', '0', '-application', 'lowdelay', '-frame_duration', '20',
      // ~60ms live clusters keep MSE latency minimal; each one is an independent append.
      '-f', 'webm', '-live', '1', '-dash', '1', '-cluster_size_limit', '16K', '-cluster_time_limit', '60',
      '-flush_packets', '1', 'pipe:1'
    ];
    let proc;
    try { proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { this.failAudio(session, `Audio capture could not start: ${error.message}`); return; }
    session.audioProcess = proc;
    const generation = (session.audioGeneration = (session.audioGeneration || 0) + 1);
    let initSent = false, stderrTail = '';
    
    proc.stdout.on('data', (chunk) => {
      if (session.ws?.readyState !== session.ws?.OPEN) return;
      // WebM is a continuous byte stream: dropping one arbitrary stdout chunk
      // corrupts every later cluster. Audio is therefore prioritized; the video
      // capture path observes bufferedAmount and yields frames first.
      if (!initSent) {
        initSent = true;
        this.sendJson(session, { type: 'audioInit', mimeType: AUDIO_MIME_TYPE, generation });
      }
      // Format byte 3 + timestamp + generation distinguishes a fresh muxer
      // stream after recovery from old bytes still draining through the socket.
      const packet = Buffer.allocUnsafe(13 + chunk.length);
      packet.writeUInt8(3, 0);
      packet.writeDoubleBE(Date.now(), 1);
      packet.writeUInt32BE(generation, 9);
      chunk.copy(packet, 13);
      session.ws.send(packet, { binary: true, compress: false });
    });
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderrTail = (stderrTail + text).slice(-400);
      if (DEBUG) log('ffmpeg audio', text.trim());
    });
    proc.once('error', (error) => {
      if (session.audioProcess === proc) session.audioProcess = null;
      const reason = error.code === 'ENOENT'
        ? 'ffmpeg is not installed on the server. Deploy with the Docker image to enable audio.'
        : `Audio capture failed: ${error.message}`;
      this.failAudio(session, reason);
    });
    proc.once('exit', (code, signal) => {
      // stopAudio clears audioProcess first, so a still-set reference means ffmpeg
      // died on its own (missing PulseAudio sink, no libopus, etc.).
      if (session.audioProcess !== proc) return;
      session.audioProcess = null;
      const detail = stderrTail.trim().split('\n').pop() || `exit ${code ?? signal}`;
      this.failAudio(session, `Audio capture stopped: ${detail}`);
    });
    
    session.stopAudio = async () => {
      if (session.audioProcess !== proc) return;
      session.audioProcess = null;
      proc.stdout.removeAllListeners('data');
      proc.kill('SIGTERM');
    };
    log('audio capture started', `session=${session.id.slice(0, 8)} source=${AUDIO_SOURCE}`);
  }
  
  async setAudioEnabled(sessionId, enabled) {
    const session = this.sessions.get(sessionId); if (!session) throw new Error('Unknown stream session.');
    session.audioEnabled = enabled;
    if (enabled) await this.startAudioCapture(session);
    else await session.stopAudio?.();
  }

  async setClientVisible(sessionId, visible) {
    const session = this.sessions.get(sessionId); if (!session) throw new Error('Unknown stream session.');
    const shouldSuspend = !visible;
    if (session.screencastSuspended === shouldSuspend) return;
    session.screencastSuspended = shouldSuspend;
    if (shouldSuspend) {
      await session.stopScreencast?.();
      log('video capture paused', `session=${session.id.slice(0, 8)}`);
      return;
    }
    const tab = session.tabs.get(session.activeTabId);
    if (tab) await this.startScreencast(session, tab);
    log('video capture resumed', `session=${session.id.slice(0, 8)}`);
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
    let navError = null;
    try { await page.goto(normalizeRemoteUrl(rawUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    catch (error) { if (isFatalNavigationError(error)) navError = describeNavigationError(error); }
    await this.sendPageInfo(session, tab); this.sendTabState(session); await this.startScreencast(session, tab);
    if (navError) throw navError;
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
      case 'navigate': {
        let navError = null;
        if (action.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        else if (action.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        else if (action.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        else if (action.action === 'goto') {
          try { await page.goto(normalizeRemoteUrl(action.url), { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
          catch (error) { if (isFatalNavigationError(error)) navError = describeNavigationError(error); }
        }
        else throw new Error('Unsupported navigation.');
        // Sync tab/url state even on failure - Chrome still commits to the failed
        // URL (showing its own error interstitial), so the UI must reflect that.
        await this.sendPageInfo(session, tab); this.sendTabState(session);
        if (navError) throw navError;
        break;
      }
      default: throw new Error('Unsupported interaction.');
    }
  }
  async cleanup() { await Promise.all([...this.sessions.keys()].map((id) => this.stopStream(id))); }
}
