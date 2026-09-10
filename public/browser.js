class RemoteBrowserClient {
  constructor() {
    this.ws = null; this.sessionId = null; this.isStreaming = false;
    this.frameCount = 0; this.fpsCounter = 0; this.lastFpsUpdate = performance.now();
    this.reconnectAttempts = 0; this.maxReconnectAttempts = Infinity; this.connectionRetryTimeout = null;
    this.latestFrame = null; this.renderScheduled = false; this.decodeInFlight = false; this.currentObjectUrl = null; this.startTimeout = null; this.firstFrameTimeout = null;
    this.pendingScroll = 0; this.scrollScheduled = false;
    this.streamVersion = 0;
    this.isMobile = this.detectMobile(); this.viewportWidth = 1280; this.viewportHeight = 720; this.updateViewportSize();
    this.elements = Object.fromEntries(['urlInput','fpsInput','qualityInput','backBtn','forwardBtn','refreshBtn','homeBtn','settingsBtn','settingsMenu','startStreamOption','stopStreamOption','stream','viewport','placeholder','loadingSpinner','loadingText','loadingSubtext','connectionOverlay','connectionTitle','connectionSubtitle','statusDot','statusText','currentUrl','fpsDisplay','frameCount','latency','loadingBar','windowTitle','suggestions'].map((id) => [id, document.getElementById(id)]));
    this.restorePreferences(); this.setupEventListeners(); this.setupResponsiveViewport();
    this.showConnectionOverlay('Connecting to server...', 'Establishing WebSocket connection'); this.connect();
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
      // Apply the new low-bandwidth defaults once; afterwards, retain choices.
      if (localStorage.getItem('remote-browser-stream-profile') !== 'fast-jpeg-v1') {
        this.elements.fpsInput.value = 16; this.elements.qualityInput.value = 32;
        localStorage.setItem('remote-browser-stream-profile', 'fast-jpeg-v1');
      } else {
        if (preferences.fps) this.elements.fpsInput.value = preferences.fps;
        if (preferences.quality) this.elements.qualityInput.value = preferences.quality;
      }
      if (preferences.url) this.elements.urlInput.value = preferences.url;
    } catch { /* Invalid local storage should never block the browser. */ }
  }
  savePreferences() {
    localStorage.setItem('remote-browser-preferences', JSON.stringify({ fps: this.fps(), quality: this.quality(), url: this.elements.urlInput.value }));
  }
  fps() { return this.clampInput(this.elements.fpsInput, 8, 24, 16); }
  quality() { return this.clampInput(this.elements.qualityInput, 18, 55, 32); }
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
    [e.fpsInput, e.qualityInput].forEach((input) => input.addEventListener('change', () => { this.fps(); this.quality(); this.savePreferences(); this.updateSettings(); }));
    document.addEventListener('pointerdown', (event) => { if (!e.settingsBtn.contains(event.target) && !e.settingsMenu.contains(event.target)) this.hideSettings(); if (!e.urlInput.closest('.url-bar').contains(event.target)) this.hideSuggestions(); });
    e.stream.addEventListener('click', (event) => this.handleClick(event));
    e.stream.addEventListener('wheel', (event) => this.handleScroll(event), { passive: false });
    e.stream.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', (event) => this.handleKeyboard(event));
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
    this.pendingScroll += event.deltaY;
    if (!this.scrollScheduled) {
      this.scrollScheduled = true;
      requestAnimationFrame(() => {
        this.sendInteraction({ type: 'scroll', deltaY: Math.round(this.pendingScroll) });
        this.pendingScroll = 0; this.scrollScheduled = false;
      });
    }
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
    this.ws = new WebSocket(`${scheme}//${window.location.host}`); this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => { this.reconnectAttempts = 0; this.updateStatus('connected', 'Connected'); this.hideConnectionOverlay(); };
    this.ws.onmessage = (event) => { if (event.data instanceof ArrayBuffer) this.receiveFrame(event.data); else { try { this.handleMessage(JSON.parse(event.data)); } catch { /* ignore malformed response */ } } };
    this.ws.onclose = () => { this.updateStatus('disconnected', 'Disconnected'); if (this.isStreaming) { this.isStreaming = false; this.sessionId = null; } this.retryConnection(); };
    this.ws.onerror = () => {};
  }
  retryConnection() {
    const delay = Math.min(20_000, 500 * (2 ** Math.min(this.reconnectAttempts++, 6))) + Math.floor(Math.random() * 250);
    this.showConnectionOverlay('Reconnecting...', `Trying again in ${Math.ceil(delay / 1000)} seconds`); this.connectionRetryTimeout = setTimeout(() => this.connect(), delay);
  }
  updateSettings() { if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'update', sessionId: this.sessionId, fps: this.fps(), quality: this.quality() })); }
  startStream() {
    if (this.ws?.readyState !== WebSocket.OPEN) return this.showConnectionOverlay('Connecting...', 'The server connection is being restored');
    let url; try { url = this.normalizeUrl(this.elements.urlInput.value || 'https://www.google.com'); } catch (error) { return this.showNotification(error.message, 'error'); }
    this.streamVersion++; this.latestFrame = null; this.decodeInFlight = false;
    this.elements.urlInput.value = url; this.savePreferences(); this.frameCount = this.fpsCounter = 0; this.showLoadingSpinner('Starting browser...', 'Loading page');
    this.ws.send(JSON.stringify({ type: 'start', url, fps: this.fps(), quality: this.quality(), width: this.viewportWidth, height: this.viewportHeight, isMobile: this.isMobile }));
    clearTimeout(this.startTimeout); this.startTimeout = setTimeout(() => { if (!this.isStreaming) this.showNotification('The stream is taking longer than expected. Please try again.', 'error'); }, 45_000);
  }
  stopStream() { if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop', sessionId: this.sessionId })); else this.resetStream(); }
  sendInteraction(action) { if (this.sessionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'interact', sessionId: this.sessionId, action })); }
  handleMessage(data) {
    if (data.type === 'started') {
      this.sessionId = data.sessionId; this.isStreaming = true; clearTimeout(this.startTimeout); this.enableNavigation(true); this.elements.startStreamOption.style.display = 'none'; this.elements.stopStreamOption.style.display = 'flex'; this.updateStatus('streaming', 'Streaming');
      clearTimeout(this.firstFrameTimeout);
      this.firstFrameTimeout = setTimeout(() => { if (this.isStreaming && this.frameCount === 0) this.showNotification('The server is connected but has not produced a frame. Retrying capture…', 'warning'); }, 12_000);
    }
    if (data.type === 'progress') { this.updateProgressBar(data.progress); if (data.message) this.elements.loadingText.textContent = data.message; if (data.subtext) this.elements.loadingSubtext.textContent = data.subtext; }
    if (data.type === 'pageInfo' && data.url) { this.elements.currentUrl.textContent = this.truncateUrl(data.url); this.elements.currentUrl.title = data.url; this.elements.urlInput.value = data.url; this.elements.windowTitle.textContent = data.title || 'Zar Browser'; }
    if (data.type === 'stopped') this.resetStream();
    if (data.type === 'error') { this.hideLoadingSpinner(); this.showNotification(data.message || 'Request failed.', 'error'); }
  }
  receiveFrame(buffer) {
    if (buffer.byteLength < 18) return;
    const view = new DataView(buffer), format = view.getUint8(0);
    if (format !== 1 && format !== 2) return;
    const mimeType = format === 2 ? 'image/jpeg' : 'image/webp';
    this.latestFrame = { timestamp: view.getFloat64(5), image: new Blob([buffer.slice(17)], { type: mimeType }) };
    if (!this.decodeInFlight && !this.renderScheduled) { this.renderScheduled = true; requestAnimationFrame(() => this.renderLatestFrame()); }
  }
  renderLatestFrame() {
    this.renderScheduled = false; if (this.decodeInFlight) return;
    const frame = this.latestFrame; this.latestFrame = null; if (!frame) return;
    const version = this.streamVersion;
    this.decodeInFlight = true;
    const url = URL.createObjectURL(frame.image), image = this.elements.stream;
    image.onload = () => {
      if (version !== this.streamVersion) { URL.revokeObjectURL(url); return; }
      const previous = this.currentObjectUrl; this.currentObjectUrl = url; if (previous) URL.revokeObjectURL(previous);
      this.decodeInFlight = false; this.recordFrame(frame.timestamp); this.scheduleLatestFrame();
    };
    image.onerror = () => { URL.revokeObjectURL(url); if (version === this.streamVersion) { this.decodeInFlight = false; this.scheduleLatestFrame(); } };
    image.src = url;
  }
  scheduleLatestFrame() { if (this.latestFrame && !this.renderScheduled) { this.renderScheduled = true; requestAnimationFrame(() => this.renderLatestFrame()); } }
  recordFrame(timestamp) {
    clearTimeout(this.firstFrameTimeout); this.frameCount++; this.fpsCounter++; this.elements.frameCount.textContent = `${this.frameCount} frames`; const now = performance.now(), elapsed = now - this.lastFpsUpdate;
    if (elapsed >= 1000) { this.elements.fpsDisplay.textContent = `${Math.round(this.fpsCounter * 1000 / elapsed)} FPS`; this.fpsCounter = 0; this.lastFpsUpdate = now; }
    this.elements.latency.textContent = `${Math.max(0, Math.round(Date.now() - timestamp))}ms`; this.elements.stream.classList.add('active'); this.hideLoadingSpinner();
  }
  resetStream() {
    clearTimeout(this.startTimeout); clearTimeout(this.firstFrameTimeout); this.streamVersion++; this.sessionId = null; this.isStreaming = false; this.latestFrame = null; this.decodeInFlight = false; this.enableNavigation(false); this.elements.stream.classList.remove('active');
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl); this.currentObjectUrl = null; this.elements.stream.removeAttribute('src'); this.elements.placeholder.style.display = 'block'; this.hideLoadingSpinner();
    this.elements.startStreamOption.style.display = 'flex'; this.elements.stopStreamOption.style.display = 'none'; this.updateStatus('connected', 'Connected');
  }
  enableNavigation(enabled) { ['backBtn','forwardBtn','refreshBtn','homeBtn'].forEach((key) => { this.elements[key].disabled = !enabled; }); }
  updateStatus(type, text) { this.elements.statusText.textContent = text; this.elements.statusDot.className = `status-dot ${type === 'disconnected' ? 'disconnected' : ''}`; }
  truncateUrl(url) { return url.length > 60 ? `${url.slice(0, 60)}…` : url; }
  hideSuggestions() { this.elements.suggestions.classList.remove('active'); }
  showNotification(message, type = 'info') { const n = document.createElement('div'); n.className = `notification ${type}`; n.textContent = message; document.body.append(n); setTimeout(() => n.remove(), 5000); }
}

const style = document.createElement('style');
style.textContent = '.notification{position:fixed;top:60px;right:20px;z-index:10000;max-width:400px;padding:12px 16px;border-radius:8px;background:#3b82f6;color:#fff;box-shadow:0 4px 12px #0004}.notification.error{background:#dc2626}.suggestion-item{width:100%;border:0;background:transparent;text-align:left;cursor:pointer;display:flex;gap:8px;align-items:center}.suggestion-item.active,.suggestion-item:hover{background:#f1f3f4}'; document.head.append(style);
document.addEventListener('DOMContentLoaded', () => new RemoteBrowserClient());
