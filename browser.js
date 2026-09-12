const AUDIO_MIME_TYPE = 'audio/webm; codecs="opus"';

class RemoteBrowserClient {
  constructor() {
    this.debug = new URLSearchParams(location.search).has('debug') || localStorage.getItem('remote-browser-debug') === '1';
    this.ws = null; this.sessionId = null; this.isStreaming = false; this.clientVisible = document.visibilityState !== 'hidden';
    this.frameCount = 0; this.fpsCounter = 0; this.lastFpsUpdate = performance.now();
    this.reconnectAttempts = 0; this.maxReconnectAttempts = Infinity; this.connectionRetryTimeout = null;
    // Ultra-optimized frame handling
    this.latestFrame = null; this.renderScheduled = false; this.decodeInFlight = false; 
    this.streamContext = null; 
    this.outputSurfaceRect = null; this.outputSurfaceDirty = true; this.outputSurfaceObserver = null;
    this.webCodecsAvailable = typeof ImageDecoder === 'function'; 
    this.startTimeout = null; this.firstFrameTimeout = null;
    this.pendingScroll = 0; this.scrollScheduled = false; this.touchState = null; this.suppressClickUntil = 0;
    this.streamVersion = 0;
    this.droppedFrames = 0;
    // Audio streaming: an MSE-backed <audio> element fed by Opus/WebM chunks
    this.audioEnabled = false; this.mediaSource = null; this.mediaSourceUrl = null; this.sourceBuffer = null; this.audioQueue = []; this.audioQueueBytes = 0; this.audioGeneration = null; this.minimumAudioGeneration = 0; this.audioRecovering = false; this.audioProtocol = 'generation'; this.audioStartTimeout = null; this.audioPrimed = false;
    this.tabs = []; this.activeTabId = null;
    this.isMobile = this.detectMobile(); this.viewportWidth = 1280; this.viewportHeight = 720; this.updateViewportSize();
    this.elements = Object.fromEntries(['urlInput','fpsInput','qualityInput','backBtn','forwardBtn','refreshBtn','homeBtn','settingsBtn','settingsMenu','startStreamOption','stopStreamOption','stream','viewport','placeholder','loadingSpinner','loadingText','loadingSubtext','connectionOverlay','connectionTitle','connectionSubtitle','statusDot','statusText','currentUrl','fpsDisplay','frameCount','latency','loadingBar','windowTitle','suggestions','browserWindow','fullscreenBtn','fullscreenExitBtn','tabsBar','newTabBtn','audioBtn','audioIcon','audioPlayer'].map((id) => [id, document.getElementById(id)]));
    this.restorePreferences(); this.setupEventListeners(); this.setupResponsiveViewport(); this.setupOutputSurface();
    this.log('client initialized', `viewport=${this.viewportWidth}x${this.viewportHeight} mobile=${this.isMobile}`); this.showConnectionOverlay('Connecting to server...', 'Establishing WebSocket connection'); this.connect();
  }

  log(message, details = '') {
    console.info(`[RBR] ${message}`, details);
  }

  detectMobile() {
    const ua = navigator.userAgent || '';
    // A narrow rendered viewport is an explicit request for the mobile site. This
    // also covers desktop Chrome's device toolbar, whose UA can remain desktop.
    return window.innerWidth <= 768 || /(?:iphone|ipod|android.*mobile|windows phone|iemobile|opera mini)/i.test(ua);
  }
  updateViewportSize() {
    const availableWidth = Math.max(320, window.innerWidth), availableHeight = Math.max(240, window.innerHeight - 150);
    if (this.detectMobile()) {
      // Do not convert a phone's tall viewport into a desktop 16:9 rectangle.
      // Sites use these CSS pixels, together with the mobile UA, to choose layout.
      this.viewportWidth = Math.round(availableWidth);
      this.viewportHeight = Math.round(availableHeight);
      return;
    }
    // Match the actual drawable area. A fixed 16:9 remote surface caused large
    // empty bars on ultrawide and mobile browser windows.
    this.viewportWidth = Math.round(Math.max(320, Math.min(availableWidth, 1920)));
    this.viewportHeight = Math.round(Math.max(240, Math.min(availableHeight, 1080)));
  }
  restorePreferences() {
    try {
      const preferences = JSON.parse(localStorage.getItem('remote-browser-preferences') || '{}');
      // Quality is now a ceiling the server adapts under, so the stored profile
      // from the old fixed-quality build has to be discarded.
      if (localStorage.getItem('remote-browser-stream-profile') !== 'stable-24fps-v7') {
        this.elements.fpsInput.value = 24;
        this.elements.qualityInput.value = 60;
        localStorage.setItem('remote-browser-stream-profile', 'stable-24fps-v7');
      } else {
        if (preferences.quality) this.elements.qualityInput.value = preferences.quality;
      }
      this.elements.fpsInput.value = 24; // Fixed stable frame cadence
      if (preferences.url) this.elements.urlInput.value = preferences.url;
    } catch { /* Invalid local storage should never block the browser. */ }
  }
  savePreferences() {
    localStorage.setItem('remote-browser-preferences', JSON.stringify({ fps: this.fps(), quality: this.quality(), url: this.elements.urlInput.value }));
  }
  fps() { this.elements.fpsInput.value = 24; return 24; }
  quality() { return this.clampInput(this.elements.qualityInput, 34, 82, 60); }
  clampInput(input, min, max, fallback) {
    const value = Number.parseInt(input.value, 10); input.value = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback; return Number(input.value);
  }
  setupResponsiveViewport() {
    let timer;
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => {
      const wasMobile = this.isMobile, oldWidth = this.viewportWidth, oldHeight = this.viewportHeight;
      this.isMobile = this.detectMobile(); this.updateViewportSize();
      // The browser profile and viewport are established at stream start. Restart
      // only after a meaningful resize or desktop/mobile breakpoint change.
      if (this.isStreaming && (wasMobile !== this.isMobile || Math.abs(oldWidth - this.viewportWidth) > 80 || Math.abs(oldHeight - this.viewportHeight) > 120)) this.startStream();
    }, 250); });
  }
  setupOutputSurface() {
    const updateRect = (rect) => {
      const width = Math.max(0, rect?.width || 0), height = Math.max(0, rect?.height || 0);
      if (this.outputSurfaceRect?.width === width && this.outputSurfaceRect?.height === height) return;
      this.outputSurfaceRect = { width, height }; this.outputSurfaceDirty = true;
      if (this.latestFrame && !this.decodeInFlight && !this.renderScheduled) this.scheduleLatestFrame();
    };
    if (typeof ResizeObserver === 'function') {
      this.outputSurfaceObserver = new ResizeObserver((entries) => updateRect(entries[0]?.contentRect));
      this.outputSurfaceObserver.observe(this.elements.stream);
    } else {
      updateRect(this.elements.stream.getBoundingClientRect());
      window.addEventListener('resize', () => updateRect(this.elements.stream.getBoundingClientRect()));
    }
  }
  setupEventListeners() {
    const e = this.elements;
    e.backBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'back' }));
    e.forwardBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'forward' }));
    e.refreshBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'reload' }));
    e.homeBtn.addEventListener('click', () => this.navigate('https://www.google.com'));
    e.urlInput.addEventListener('input', () => this.updateSuggestions(e.urlInput.value));
    e.urlInput.addEventListener('focus', () => this.updateSuggestions(e.urlInput.value));
    e.urlInput.addEventListener('keydown', (event) => this.handleUrlKeydown(event));
    e.settingsBtn.addEventListener('click', (event) => { event.stopPropagation(); this.toggleSettings(); });
    e.settingsMenu.addEventListener('click', (event) => event.stopPropagation());
    e.startStreamOption.addEventListener('click', () => { this.startStream(); this.hideSettings(); });
    e.stopStreamOption.addEventListener('click', () => { this.stopStream(); this.hideSettings(); });
    e.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    e.fullscreenExitBtn.addEventListener('click', () => this.toggleFullscreen());
    e.newTabBtn.addEventListener('click', () => this.createTab());
    e.audioBtn.addEventListener('click', () => { this.toggleAudio(!this.audioEnabled); });
    [e.fpsInput, e.qualityInput].forEach((input) => input.addEventListener('change', () => { this.fps(); this.quality(); this.savePreferences(); this.updateSettings(); }));
    document.addEventListener('pointerdown', (event) => { if (!e.settingsBtn.contains(event.target) && !e.settingsMenu.contains(event.target)) this.hideSettings(); if (!e.urlInput.closest('.url-bar').contains(event.target)) this.hideSuggestions(); });
    const focusStream = () => {
      if (document.activeElement === e.urlInput) {
        e.urlInput.blur();
      }
      this.hideSuggestions();
      e.stream.focus?.({ preventScroll: true });
    };
    e.viewport.addEventListener('pointerdown', focusStream);
    e.stream.addEventListener('pointerdown', (event) => {
      focusStream();
      this.handlePointerDown(event);
    }, { passive: false });
    e.stream.addEventListener('click', (event) => {
      focusStream();
      if (Date.now() >= this.suppressClickUntil) this.handleClick(event);
    });
    e.stream.addEventListener('wheel', (event) => this.handleScroll(event), { passive: false });
    e.stream.addEventListener('pointermove', (event) => this.handlePointerMove(event), { passive: false });
    e.stream.addEventListener('pointerup', (event) => this.handlePointerUp(event), { passive: false });
    e.stream.addEventListener('pointercancel', () => { this.touchState = null; });
    e.stream.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', (event) => this.handleKeyboard(event));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) this.elements.browserWindow.classList.remove('focus-mode');
    });
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
  }
  handleVisibilityChange() {
    this.clientVisible = document.visibilityState !== 'hidden';
    if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'visibility', sessionId: this.sessionId, visible: this.clientVisible }));
    }
    if (this.clientVisible && this.latestFrame && !this.decodeInFlight && !this.renderScheduled) {
      this.renderScheduled = true;
      requestAnimationFrame(() => this.renderLatestFrame());
    }
  }
  toggleSettings() {
    if (this.elements.settingsMenu.classList.contains('active')) return this.hideSettings();
    const rect = this.elements.settingsBtn.getBoundingClientRect(), menu = this.elements.settingsMenu;
    menu.classList.add('active');
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
  }
  hideSettings() { this.elements.settingsMenu.classList.remove('active'); }
  async toggleFullscreen() {
    const root = this.elements.browserWindow;
    try {
      if (document.fullscreenElement) { await document.exitFullscreen?.(); root.classList.remove('focus-mode'); }
      else if (root.classList.contains('focus-mode')) root.classList.remove('focus-mode');
      else { root.classList.add('focus-mode'); await root.requestFullscreen?.(); }
    } catch { /* Focus mode still gives the user the full content area. */ }
    setTimeout(() => this.updateViewportSize(), 0);
  }
  createTab() {
    if (!this.isStreaming) return this.startStream();
    this.sendTabCommand('create', { url: 'https://www.google.com' });
  }
  sendTabCommand(action, extra = {}) {
    if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'tab', sessionId: this.sessionId, action, ...extra }));
  }
  renderTabs() {
    const bar = this.elements.tabsBar, plus = this.elements.newTabBtn;
    bar.querySelectorAll('.tab').forEach((node) => node.remove());
    this.tabs.forEach((tab) => {
      const item = document.createElement('button'); item.type = 'button'; item.className = `tab ${tab.id === this.activeTabId ? 'active' : ''}`; item.title = tab.title || tab.url;
      const icon = document.createElement('span'); icon.className = 'tab-favicon'; icon.textContent = '◉';
      const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.title || 'New Tab';
      const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.title = 'Close tab';
      close.addEventListener('click', (event) => { event.stopPropagation(); this.sendTabCommand('close', { tabId: tab.id }); });
      item.addEventListener('click', () => { if (tab.id !== this.activeTabId) this.sendTabCommand('switch', { tabId: tab.id }); });
      item.append(icon, title, close); bar.insertBefore(item, plus);
    });
    plus.disabled = this.tabs.length >= 3;
  }
  updateSuggestions(query) {
    const suggestions = this.elements.suggestions, cleanQuery = query.trim();
    if (!cleanQuery) return this.hideSuggestions();
    const sites = [['Google','https://www.google.com'],['YouTube','https://www.youtube.com'],['Wikipedia','https://www.wikipedia.org'],['GitHub','https://github.com'],['Stack Overflow','https://stackoverflow.com']]
      .filter(([name, url]) => name.toLowerCase().includes(cleanQuery.toLowerCase()) || url.includes(cleanQuery.toLowerCase()));
    const entries = [[`Search Google for “${cleanQuery}”`, `https://www.google.com/search?q=${encodeURIComponent(cleanQuery)}`, 'Search'], ...sites.map(([name, url]) => [name, url, 'Site'])];
    suggestions.replaceChildren(...entries.slice(0, 8).map(([name, url, type]) => {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'suggestion-item'; item.dataset.url = url;
      const text = document.createElement('span'); text.className = 'suggestion-text'; text.textContent = name;
      const kind = document.createElement('span'); kind.className = 'suggestion-type'; kind.textContent = type;
      item.append(text, kind); item.addEventListener('click', () => this.navigate(url)); return item;
    }));
    suggestions.classList.add('active');
  }
  handleUrlKeydown(event) {
    const items = [...this.elements.suggestions.querySelectorAll('.suggestion-item')], active = this.elements.suggestions.querySelector('.active');
    if (event.key === 'Enter') { event.preventDefault(); this.navigate(active?.dataset.url || this.elements.urlInput.value); return; }
    if (event.key === 'Escape') return this.hideSuggestions();
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !items.length) return;
    event.preventDefault(); const index = active ? items.indexOf(active) : -1;
    active?.classList.remove('active'); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].classList.add('active');
  }
  showLoadingSpinner(text, subtext) { this.elements.loadingText.textContent = text; this.elements.loadingSubtext.textContent = subtext; this.elements.loadingSpinner.classList.add('active'); this.elements.loadingBar.classList.add('active'); this.elements.placeholder.style.display = 'none'; }
  hideLoadingSpinner() { this.elements.loadingSpinner.classList.remove('active'); this.elements.loadingBar.classList.remove('active'); this.elements.loadingBar.style.width = '0%'; }
  updateProgressBar(progress) { this.elements.loadingBar.classList.add('active'); this.elements.loadingBar.style.width = `${Math.min(100, Math.max(0, progress))}%`; }
  showConnectionOverlay(title, subtitle) { this.elements.connectionTitle.textContent = title; this.elements.connectionSubtitle.textContent = subtitle; this.elements.connectionOverlay.classList.add('active'); }
  hideConnectionOverlay() { this.elements.connectionOverlay.classList.remove('active'); }
  handleClick(event) {
    if (!this.isStreaming) return; event.preventDefault(); const rect = this.elements.stream.getBoundingClientRect();
    this.sendInteraction({ type: 'click', x: Math.round((event.clientX - rect.left) * this.viewportWidth / rect.width), y: Math.round((event.clientY - rect.top) * this.viewportHeight / rect.height), button: 'left' });
  }
  handleScroll(event) {
    if (!this.isStreaming) return; event.preventDefault();
    this.queueScroll(event.deltaY);
  }
  queueScroll(deltaY) {
    this.pendingScroll += deltaY;
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    // One animation frame merges bursty wheel/touch updates without adding the
    // extra ~16ms delay that made mobile scrolling feel detached.
    requestAnimationFrame(() => {
      this.sendInteraction({ type: 'scroll', deltaY: Math.round(Math.max(-2_000, Math.min(2_000, this.pendingScroll))) });
      this.pendingScroll = 0; this.scrollScheduled = false;
    });
  }
  handlePointerDown(event) {
    if (!this.isStreaming || event.pointerType !== 'touch') return;
    event.preventDefault(); this.elements.stream.setPointerCapture?.(event.pointerId);
    this.log('touch start', `${event.clientX},${event.clientY}`);
    this.touchState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastY: event.clientY, moved: false };
  }
  handlePointerMove(event) {
    const touch = this.touchState;
    if (!touch || touch.pointerId !== event.pointerId) return;
    event.preventDefault(); const deltaY = touch.lastY - event.clientY;
    if (Math.abs(event.clientX - touch.startX) > 8 || Math.abs(event.clientY - touch.startY) > 8) touch.moved = true;
    touch.lastY = event.clientY; if (deltaY) this.queueScroll(deltaY);
  }
  handlePointerUp(event) {
    const touch = this.touchState;
    if (!touch || touch.pointerId !== event.pointerId) return;
    event.preventDefault(); this.touchState = null; this.suppressClickUntil = Date.now() + 500;
    this.log('touch end', touch.moved ? 'scroll gesture' : 'tap');
    if (!touch.moved) this.handleClick(event);
  }
  handleKeyboard(event) {
    if (event.target === this.elements.urlInput || !this.isStreaming) return;
    if ((event.ctrlKey || event.metaKey) && ['c','v','a','x'].includes(event.key.toLowerCase())) { event.preventDefault(); this.sendInteraction({ type: 'key', key: `${event.ctrlKey ? 'Control' : 'Meta'}+${event.key.toUpperCase()}` }); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); this.sendInteraction({ type: 'navigate', action: 'reload' }); return; }
    if (['Enter','Backspace','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete'].includes(event.key)) { event.preventDefault(); this.sendInteraction({ type: 'key', key: event.key }); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); this.sendInteraction({ type: 'type', text: event.key }); }
  }
  normalizeUrl(value) {
    const text = String(value || '').trim(); if (!text) throw new Error('Enter a URL or search term.');
    if (/\s/.test(text) || !/[.:]/.test(text)) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS URLs are supported.');
    return url.toString();
  }
  navigate(value) {
    let url; try { url = this.normalizeUrl(value); } catch (error) { this.showNotification(error.message, 'error'); return; }
    this.elements.urlInput.value = url; this.savePreferences(); this.hideSuggestions();
    if (!this.isStreaming) return this.startStream();
    this.showLoadingSpinner('Navigating...', 'Loading new page'); this.sendInteraction({ type: 'navigate', action: 'goto', url });
  }
  connect() {
    clearTimeout(this.connectionRetryTimeout); const scheme = window.location.protocol === 'https:' || window.location.hostname !== 'localhost' ? 'wss:' : 'ws:';
    const wsUrl = `${scheme}//${window.location.host}`; this.log('connecting', wsUrl);
    this.ws = new WebSocket(wsUrl); this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => { this.log('websocket connected'); this.reconnectAttempts = 0; this.updateStatus('connected', 'Connected'); this.hideConnectionOverlay(); };
    this.ws.onmessage = (event) => { if (event.data instanceof ArrayBuffer) this.receiveBinary(event.data); else { try { this.handleMessage(JSON.parse(event.data)); } catch { /* ignore malformed response */ } } };
    this.ws.onclose = (event) => { this.log('websocket closed', `${event.code} ${event.reason || ''}`); this.updateStatus('disconnected', 'Disconnected'); if (this.isStreaming) { this.isStreaming = false; this.sessionId = null; } this.retryConnection(); };
    this.ws.onerror = (error) => this.log('websocket error', error);
  }
  retryConnection() {
    const delay = Math.min(20_000, 500 * (2 ** Math.min(this.reconnectAttempts++, 6))) + Math.floor(Math.random() * 250);
    this.showConnectionOverlay('Reconnecting...', `Trying again in ${Math.ceil(delay / 1000)} seconds`); this.connectionRetryTimeout = setTimeout(() => this.connect(), delay);
  }
  updateSettings() { if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'update', sessionId: this.sessionId, fps: this.fps(), quality: this.quality() })); }
  startStream() {
    if (this.ws?.readyState !== WebSocket.OPEN) return this.showConnectionOverlay('Connecting...', 'The server connection is being restored');
    let url; try { url = this.normalizeUrl(this.elements.urlInput.value || 'https://www.google.com'); } catch (error) { return this.showNotification(error.message, 'error'); }
    this.streamVersion++; this.latestFrame = null;
    this.elements.urlInput.value = url; this.savePreferences(); this.frameCount = this.fpsCounter = 0; this.showLoadingSpinner('Starting browser...', 'Loading page');
    this.log('starting stream', `${url} ${this.viewportWidth}x${this.viewportHeight} mobile=${this.isMobile}`);
    this.ws.send(JSON.stringify({ type: 'start', url, fps: this.fps(), quality: this.quality(), width: this.viewportWidth, height: this.viewportHeight, isMobile: this.isMobile, enableAudio: this.audioEnabled }));
    clearTimeout(this.startTimeout); this.startTimeout = setTimeout(() => { if (!this.isStreaming) this.showNotification('The stream is taking longer than expected. Please try again.', 'error'); }, 45_000);
  }
  stopStream() { if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop', sessionId: this.sessionId })); else this.resetStream(); }
  sendInteraction(action) { if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'interact', sessionId: this.sessionId, action })); }
  handleMessage(data) {
    if (data.type === 'started') {
      this.log('stream started', data.sessionId);
      this.sessionId = data.sessionId; this.isStreaming = true; clearTimeout(this.startTimeout); this.enableNavigation(true); this.elements.startStreamOption.style.display = 'none'; this.elements.stopStreamOption.style.display = 'flex'; this.updateStatus('streaming', 'Streaming');
      if (!this.clientVisible && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'visibility', sessionId: this.sessionId, visible: false }));
      clearTimeout(this.firstFrameTimeout);
      this.firstFrameTimeout = setTimeout(() => { if (this.isStreaming && this.frameCount === 0) this.showNotification('The server is connected but has not produced a frame. Retrying capture…', 'warning'); }, 12_000);
    }
    if (data.type === 'progress') { this.updateProgressBar(data.progress); if (data.message) this.elements.loadingText.textContent = data.message; if (data.subtext) this.elements.loadingSubtext.textContent = data.subtext; }
    if (data.type === 'pageInfo' && data.url) { this.elements.currentUrl.textContent = this.truncateUrl(data.url); this.elements.currentUrl.title = data.url; this.elements.urlInput.value = data.url; this.elements.windowTitle.textContent = data.title || 'Zar Browser'; }
    if (data.type === 'tabState') { this.tabs = Array.isArray(data.tabs) ? data.tabs : []; this.activeTabId = data.activeTabId; this.log('tabs updated', `${this.tabs.length} tabs`); this.renderTabs(); }
    if (data.type === 'stopped') this.resetStream();
    if (data.type === 'capabilities') {
      const btn = this.elements.audioBtn, ok = Boolean(data.audio?.available);
      btn.disabled = !ok; btn.title = ok ? (this.audioEnabled ? 'Mute Audio' : 'Unmute Audio') : `Audio unavailable: ${data.audio?.reason || 'server has no capture backend'}`;
      if (!ok && this.audioEnabled) { this.audioEnabled = false; this.updateAudioIcon(); this.teardownAudio(); }
      if (!ok) this.log('audio unavailable', data.audio?.reason || '');
    }
    if (data.type === 'audioInit' && this.audioEnabled) this.handleAudioInit(data);
    if (data.type === 'audioError') {
      this.audioEnabled = false; this.updateAudioIcon(); this.teardownAudio();
      this.showNotification(data.message || 'Audio is unavailable.', 'error');
    }
    if (data.type === 'error') { this.hideLoadingSpinner(); this.showNotification(data.message || 'Request failed.', 'error'); }
  }
  receiveBinary(buffer) {
    if (buffer.byteLength < 1) return;
    const format = new DataView(buffer).getUint8(0);
    if (format === 3) this.receiveAudioChunk(buffer);
    else this.receiveFrame(buffer);
  }
  updateAudioIcon() {
    if (!this.elements.audioIcon) return;
    this.elements.audioIcon.innerHTML = this.audioEnabled 
      ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15.536a5 5 0 001.414 1.06m2.828-9.9a9 9 0 000 12.728"></path>' 
      : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15.536a5 5 0 001.414 1.06m2.828-9.9a9 9 0 000 12.728M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M3 3l18 18"></path>';
    this.elements.audioBtn.title = this.audioEnabled ? 'Mute Audio' : 'Unmute Audio';
  }
  toggleAudio(enabled) {
    if (!enabled) { this.audioEnabled = false; this.updateAudioIcon(); this.teardownAudio(); this.sendAudioCommand(false); return; }
    if (typeof MediaSource !== 'function' || !MediaSource.isTypeSupported(AUDIO_MIME_TYPE)) {
      this.audioEnabled = false; this.updateAudioIcon();
      this.showNotification('Audio streaming is not supported in this browser.', 'error');
      return;
    }
    this.audioEnabled = true;
    this.audioGeneration = null; this.minimumAudioGeneration = 0;
    this.updateAudioIcon();
    // Must happen inside the click handler: autoplay policy only honours play()
    // while a user gesture is active, and the server's first chunk arrives later.
    this.setupAudio(AUDIO_MIME_TYPE);
    this.sendAudioCommand(true);
    this.armAudioStartTimeout();
  }
  armAudioStartTimeout() {
    clearTimeout(this.audioStartTimeout);
    this.audioStartTimeout = setTimeout(() => {
      if (this.audioEnabled && this.audioGeneration === null) this.showNotification('Audio capture has not started. Check the server audio logs.', 'warning');
    }, 8_000);
  }
  sendAudioCommand(enabled) {
    if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'audio', sessionId: this.sessionId, enabled }));
  }
  setupAudio(mimeType) {
    if (this.mediaSource || typeof MediaSource !== 'function' || !MediaSource.isTypeSupported(mimeType)) return;
    const player = this.elements.audioPlayer;
    this.mediaSource = new MediaSource();
    this.mediaSourceUrl = URL.createObjectURL(this.mediaSource);
    player.src = this.mediaSourceUrl;
    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
      this.sourceBuffer.mode = 'sequence';
      this.sourceBuffer.addEventListener('updateend', () => this.onAudioUpdateEnd());
      this.sourceBuffer.addEventListener('error', () => {
        if (this.debug) this.log('audio SourceBuffer error');
        this.recoverAudio();
      });
      this.pumpAudioQueue();
    }, { once: true });
    player.play().catch((error) => { if (this.debug) this.log('audio play blocked', error.message); });
  }
  handleAudioInit(data) {
    // Servers before the generation protocol used a 9-byte audio header. Keep
    // them working during a rolling deployment instead of silently dropping all
    // sound until both sides happen to update at the same moment.
    const hasGeneration = Number.isSafeInteger(Number(data.generation));
    const generation = hasGeneration ? Number(data.generation) : 0;
    this.audioProtocol = hasGeneration ? 'generation' : 'legacy';
    if (generation < this.minimumAudioGeneration) return;
    if (this.audioGeneration !== null && generation !== this.audioGeneration) this.teardownAudio(false);
    this.audioGeneration = generation; this.minimumAudioGeneration = generation;
    this.audioRecovering = false;
    clearTimeout(this.audioStartTimeout);
    this.log('audio stream ready', `${this.audioProtocol} generation=${generation}`);
    this.setupAudio(data.mimeType || AUDIO_MIME_TYPE);
  }
  receiveAudioChunk(buffer) {
    const isGenerated = this.audioProtocol === 'generation';
    if (!this.audioEnabled || buffer.byteLength < (isGenerated ? 14 : 10)) return;
    const generation = isGenerated ? new DataView(buffer).getUint32(9) : 0;
    if (generation !== this.audioGeneration) return;
    if (!this.mediaSource) this.setupAudio(AUDIO_MIME_TYPE);
    const chunk = buffer.slice(isGenerated ? 13 : 9);
    this.audioQueue.push(chunk); this.audioQueueBytes += chunk.byteLength;
    // Never discard a fragment from a continuous WebM stream. If local MSE is
    // genuinely stalled, reset both ends onto a new, independently initialized
    // muxer stream instead of corrupting the current one.
    if (this.audioQueueBytes > 256 * 1024) return this.recoverAudio();
    this.pumpAudioQueue();
  }
  pumpAudioQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.audioQueue.length) return;
    const chunk = this.audioQueue[0];
    try {
      this.sourceBuffer.appendBuffer(chunk);
      this.audioQueue.shift(); this.audioQueueBytes -= chunk.byteLength;
    } catch (error) {
      if (this.debug) this.log('audio append deferred', error.message);
      if (error.name === 'QuotaExceededError') return this.recoverAudio();
      setTimeout(() => this.pumpAudioQueue(), 50);
    }
  }
  onAudioUpdateEnd() {
    const sb = this.sourceBuffer, player = this.elements.audioPlayer;
    if (!sb || sb.updating) return;
    const buffered = sb.buffered;
    if (buffered.length) {
      const start = buffered.start(0), end = buffered.end(buffered.length - 1);
      // Prime a short, fixed jitter cushion before normal live playback. It is
      // long enough to cover scheduling/network wobble but short enough that
      // audio remains aligned with the video stream.
      if (!this.audioPrimed) {
        if (end - start < 0.14) { this.pumpAudioQueue(); return; }
        this.audioPrimed = true;
        if (player.currentTime < start || player.currentTime > end) player.currentTime = Math.max(start, end - 0.14);
        this.log('audio jitter buffer primed', `${Math.round((end - start) * 1000)}ms`);
      }
      // Evict played audio aggressively: 10s retention (was 30s), 3s keepback (was 10s).
      if (player.currentTime - start > 10) { try { sb.remove(start, player.currentTime - 3); return; } catch { /* fall through */ } }
      // Prefer continuous playback. Only seek when latency is clearly broken;
      // minor drift is corrected gently so words do not skip or stutter.
      const lag = end - player.currentTime;
      if (lag > 1) { player.currentTime = Math.max(start, end - 0.2); player.playbackRate = 1; }
      else if (lag > 0.45) player.playbackRate = 1.04;
      else if (player.playbackRate !== 1 && lag < 0.25) player.playbackRate = 1;
      if (player.paused && this.audioEnabled) player.play().catch(() => {});
    }
    this.pumpAudioQueue();
  }
  recoverAudio() {
    if (this.audioRecovering || !this.audioEnabled) return;
    this.audioRecovering = true;
    this.minimumAudioGeneration = this.audioProtocol === 'generation' ? (this.audioGeneration || 0) + 1 : 0;
    this.teardownAudio(false); this.sendAudioCommand(false);
    setTimeout(() => {
      if (!this.audioEnabled) return;
      this.armAudioStartTimeout();
      this.sendAudioCommand(true);
    }, 150);
  }
  teardownAudio(resetGeneration = true) {
    this.audioQueue = []; this.audioQueueBytes = 0; this.sourceBuffer = null; this.audioPrimed = false;
    clearTimeout(this.audioStartTimeout);
    const player = this.elements.audioPlayer;
    player.pause(); player.removeAttribute('src'); player.load();
    if (this.mediaSourceUrl) { URL.revokeObjectURL(this.mediaSourceUrl); this.mediaSourceUrl = null; }
    this.mediaSource = null;
    if (resetGeneration) { this.audioGeneration = null; this.minimumAudioGeneration = 0; }
  }
  receiveFrame(buffer) {
    if (buffer.byteLength < 18) return;
    const view = new DataView(buffer), format = view.getUint8(0);
    if (format !== 1 && format !== 2) return;
    const mimeType = format === 2 ? 'image/jpeg' : 'image/webp';
    
    // The server already paces to the target frame rate, so every delivered frame
    // is worth keeping; the newest simply supersedes an undrawn one.
    if (this.latestFrame) { this.latestFrame.bytes = null; this.droppedFrames++; }
    
    // WebSocket message buffers are immutable and exclusive to this message.
    // Keeping a view avoids copying every JPEG before the decoder has even seen it.
    this.latestFrame = { timestamp: view.getFloat64(5), mimeType, bytes: new Uint8Array(buffer, 17) };
    
    // Immediate scheduling for lowest latency
    if (this.clientVisible && !this.decodeInFlight && !this.renderScheduled) {
      this.renderScheduled = true; 
      requestAnimationFrame(() => this.renderLatestFrame()); 
    }
  }
  ensureContext() {
    if (this.streamContext) return true;
    this.streamContext = this.elements.stream.getContext('2d', { alpha: false, desynchronized: true, willReadFrequently: false });
    if (this.streamContext) {
      this.streamContext.imageSmoothingEnabled = true;
      this.streamContext.imageSmoothingQuality = 'high';
      this.streamContext.globalCompositeOperation = 'copy';
    }
    return Boolean(this.streamContext);
  }
  resizeOutputSurface() {
    if (!this.ensureContext()) return false;
    const canvas = this.elements.stream, rect = this.outputSurfaceRect;
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    if (!this.outputSurfaceDirty) return true;
    // Render the upscaled result at the client display density instead of
    // relying on a second, lower-quality CSS stretch of the small source frame.
    // The cap keeps the local surface light enough for mid-range phones.
    const density = Math.min(window.devicePixelRatio || 1, 2);
    // Keep the final upscale detailed without making the client render more
    // pixels than a 24fps stream can present smoothly.
    const pixelBudget = this.isMobile ? 829_440 : 1_350_000;
    let width = Math.max(1, Math.round(rect.width * density));
    let height = Math.max(1, Math.round(rect.height * density));
    const scale = Math.min(1, Math.sqrt(pixelBudget / (width * height)));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    if (canvas.width === width && canvas.height === height) { this.outputSurfaceDirty = false; return true; }
    canvas.width = width; canvas.height = height;
    // Resizing a canvas resets its drawing state.
    this.streamContext.imageSmoothingEnabled = true;
    this.streamContext.imageSmoothingQuality = 'high';
    this.streamContext.globalCompositeOperation = 'copy';
    this.outputSurfaceDirty = false;
    return true;
  }
  async decodeFrame(frame) {
    if (this.webCodecsAvailable) {
      // An ImageDecoder is bound to the buffer it was constructed with, so a new
      // one is required per frame; reusing it would replay the first frame forever.
      let decoder = null;
      try {
        decoder = new ImageDecoder({ type: frame.mimeType, data: frame.bytes, preferAnimation: false });
        const result = await decoder.decode({ frameIndex: 0 });
        return { source: result.image, dispose: () => { result.image.close(); decoder.close(); } };
      } catch (error) {
        decoder?.close();
        this.webCodecsAvailable = false;
        this.log('WebCodecs unavailable, using ImageBitmap', error.message);
      }
    }
    
    // Fast ImageBitmap fallback – premultiplyAlpha:'none' skips alpha processing
    // since our canvas is opaque (alpha:false), saving GPU work on every frame.
    const blob = new Blob([frame.bytes], { type: frame.mimeType });
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      return { source: bitmap, dispose: () => bitmap.close() };
    }
    
    // Legacy fallback
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob), image = new Image();
      image.onload = () => resolve({ source: image, dispose: () => URL.revokeObjectURL(url) });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
      image.src = url;
    });
  }
  async renderLatestFrame() {
    this.renderScheduled = false; 
    if (this.decodeInFlight || !this.latestFrame || !this.clientVisible) return;
    
    const frame = this.latestFrame; 
    this.latestFrame = null;
    const version = this.streamVersion;
    
    this.decodeInFlight = true;
    try {
      const decoded = await this.decodeFrame(frame);
      
      if (version === this.streamVersion) this.elements.stream.classList.add('active');
      if (version === this.streamVersion && this.resizeOutputSurface()) {
        const canvas = this.elements.stream;
        const source = decoded.source;
        // High-quality canvas filtering performs the one required client-side
        // scale in the persistent output surface, which fills the viewport.
        this.streamContext.drawImage(source, 0, 0, canvas.width, canvas.height);
        this.recordFrame(frame.timestamp);
      }
      
      decoded.dispose();
      frame.bytes = null;
    } catch (error) {
      if (this.debug) this.log('frame decode failed', error.message);
    } finally {
      this.decodeInFlight = false;
      // Present at the display cadence. Decoding and painting several frames in
      // one turn cannot improve what the user sees; it only competes with input,
      // scrolling and the compositor. The latest pending frame still wins.
      if (this.latestFrame && !this.renderScheduled) {
        this.renderScheduled = true;
        requestAnimationFrame(() => this.renderLatestFrame());
      }
    }
  }
  scheduleLatestFrame() { if (this.latestFrame && !this.renderScheduled) { this.renderScheduled = true; requestAnimationFrame(() => this.renderLatestFrame()); } }
  recordFrame(timestamp) {
    clearTimeout(this.firstFrameTimeout); this.frameCount++; this.fpsCounter++; this.elements.frameCount.textContent = `${this.frameCount} frames`; const now = performance.now(), elapsed = now - this.lastFpsUpdate;
    if (elapsed >= 1000) { 
      const actualFps = Math.round(this.fpsCounter * 1000 / elapsed);
      this.elements.fpsDisplay.textContent = `${actualFps} FPS`; 
      this.fpsCounter = 0; this.lastFpsUpdate = now; 
      // Log performance stats with dropped frames
      if (this.debug) this.log('performance', `fps=${actualFps} dropped=${this.droppedFrames}`);
      this.droppedFrames = 0;
    }
    const latency = Math.max(0, Math.round(Date.now() - timestamp)); this.elements.latency.textContent = `${latency}ms`; this.elements.stream.classList.add('active'); this.hideLoadingSpinner();
    if (this.frameCount % 24 === 0 && this.debug) this.log('frame stats', `fps=${this.elements.fpsDisplay.textContent} latency=${latency}ms rendered=24`);
  }
  resetStream() {
    clearTimeout(this.startTimeout); clearTimeout(this.firstFrameTimeout); this.streamVersion++; this.sessionId = null; this.isStreaming = false; this.tabs = []; this.activeTabId = null; this.renderTabs(); 
    
    // Clean up all frame references to free memory
    this.cleanupFrames();
    this.teardownAudio();
    this.decodeInFlight = false; this.enableNavigation(false); this.elements.stream.classList.remove('active');
    if (this.streamContext) {
      // Resetting dimensions releases the backing surface instead of keeping a
      // large GPU/CPU allocation alive while the stream is stopped.
      this.elements.stream.width = 1; this.elements.stream.height = 1;
      this.streamContext = null;
    }
    this.elements.placeholder.style.display = 'block'; this.hideLoadingSpinner();
    this.elements.startStreamOption.style.display = 'flex'; this.elements.stopStreamOption.style.display = 'none'; this.updateStatus('connected', 'Connected');
  }
  enableNavigation(enabled) { ['backBtn','forwardBtn','refreshBtn','homeBtn'].forEach((key) => { this.elements[key].disabled = !enabled; }); }
  updateStatus(type, text) { this.elements.statusText.textContent = text; this.elements.statusDot.className = `status-dot ${type === 'disconnected' ? 'disconnected' : ''}`; }
  truncateUrl(url) { return url.length > 60 ? `${url.slice(0, 60)}…` : url; }
  hideSuggestions() { this.elements.suggestions.classList.remove('active'); }
  showNotification(message, type = 'info') { const n = document.createElement('div'); n.className = `notification ${type}`; n.textContent = message; document.body.append(n); setTimeout(() => n.remove(), 5000); }
  
  cleanupFrames() {
    if (this.latestFrame) { this.latestFrame.bytes = null; this.latestFrame = null; }
  }
  
  // Clean up on page unload
  cleanup() {
    this.cleanupFrames();
    this.teardownAudio();
    this.outputSurfaceObserver?.disconnect();
    this.outputSurfaceObserver = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

const style = document.createElement('style');
style.textContent = '.notification{position:fixed;top:60px;right:20px;z-index:10000;max-width:400px;padding:12px 16px;border-radius:8px;background:#3b82f6;color:#fff;box-shadow:0 4px 12px #0004}.notification.error{background:#dc2626}.suggestion-item{width:100%;border:0;background:transparent;text-align:left;cursor:pointer;display:flex;gap:8px;align-items:center}.suggestion-item.active,.suggestion-item:hover{background:#f1f3f4}'; document.head.append(style);

let clientInstance = null;
document.addEventListener('DOMContentLoaded', () => {
  clientInstance = new RemoteBrowserClient();
});

// Cleanup on page unload to free memory
window.addEventListener('beforeunload', () => {
  if (clientInstance) clientInstance.cleanup();
});
