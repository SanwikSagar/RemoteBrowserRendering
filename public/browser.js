class RemoteBrowserClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.frameCount = 0;
    this.fpsCounter = 0;
    this.lastFpsUpdate = Date.now();
    this.isStreaming = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.connectionRetryTimeout = null;
    
    // Performance optimizations - frame buffering for smooth display
    this.frameQueue = [];
    this.isProcessingFrame = false;
    this.lastFrameTime = 0;
    this.targetFrameTime = 1000 / 60; // 60 FPS target for smooth display
    
    // Responsive viewport - dynamic sizing based on window
    this.viewportWidth = 1280;
    this.viewportHeight = 720;
    this.updateViewportSize();
    
    // Input debouncing for ultra-fast response
    this.inputDebounceTimeout = null;
    this.inputDebounceDelay = 50; // 50ms for instant feel
    
    this.elements = {
      urlInput: document.getElementById('urlInput'),
      fpsInput: document.getElementById('fpsInput'),
      qualityInput: document.getElementById('qualityInput'),
      backBtn: document.getElementById('backBtn'),
      forwardBtn: document.getElementById('forwardBtn'),
      refreshBtn: document.getElementById('refreshBtn'),
      homeBtn: document.getElementById('homeBtn'),
      settingsBtn: document.getElementById('settingsBtn'),
      settingsMenu: document.getElementById('settingsMenu'),
      startStreamOption: document.getElementById('startStreamOption'),
      stopStreamOption: document.getElementById('stopStreamOption'),
      stream: document.getElementById('stream'),
      viewport: document.getElementById('viewport'),
      placeholder: document.getElementById('placeholder'),
      loadingSpinner: document.getElementById('loadingSpinner'),
      loadingText: document.getElementById('loadingText'),
      loadingSubtext: document.getElementById('loadingSubtext'),
      connectionOverlay: document.getElementById('connectionOverlay'),
      connectionTitle: document.getElementById('connectionTitle'),
      connectionSubtitle: document.getElementById('connectionSubtitle'),
      statusDot: document.getElementById('statusDot'),
      statusText: document.getElementById('statusText'),
      currentUrl: document.getElementById('currentUrl'),
      fpsDisplay: document.getElementById('fpsDisplay'),
      frameCountEl: document.getElementById('frameCount'),
      latency: document.getElementById('latency'),
      loadingBar: document.getElementById('loadingBar'),
      windowTitle: document.getElementById('windowTitle')
    };

    this.setupEventListeners();
    this.setupResponsiveViewport();
    this.showConnectionOverlay('Connecting to server...', 'Establishing WebSocket connection');
    this.connect();
  }

  updateViewportSize() {
    // Calculate optimal viewport based on window size
    const navHeight = 120; // Approximate combined height of nav bars
    const statusHeight = 28;
    const availableWidth = window.innerWidth;
    const availableHeight = window.innerHeight - navHeight - statusHeight;
    
    // Use 16:9 aspect ratio, fit within available space
    const aspectRatio = 16 / 9;
    let width = availableWidth;
    let height = width / aspectRatio;
    
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspectRatio;
    }
    
    // Ensure reasonable minimum and maximum sizes
    width = Math.max(800, Math.min(width, 1920));
    height = Math.round(width / aspectRatio);
    
    this.viewportWidth = Math.round(width);
    this.viewportHeight = Math.round(height);
    
    console.log(`📐 Viewport size: ${this.viewportWidth}x${this.viewportHeight}`);
  }

  setupResponsiveViewport() {
    // Update viewport on resize with debounce
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.updateViewportSize();
        // If streaming, restart with new size
        if (this.isStreaming) {
          console.log('📐 Window resized, restarting stream with new viewport...');
          this.stopStream();
          setTimeout(() => this.startStream(), 500);
        }
      }, 300);
    });
  }

  setupEventListeners() {
    // Navigation controls
    this.elements.backBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'back' }));
    this.elements.forwardBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'forward' }));
    this.elements.refreshBtn.addEventListener('click', () => this.navigate(this.elements.urlInput.value));
    this.elements.homeBtn.addEventListener('click', () => {
      this.elements.urlInput.value = 'https://www.google.com';
      this.navigate('https://www.google.com');
    });
    
    // URL input with optimized handling
    this.elements.urlInput.addEventListener('input', (e) => this.handleUrlInput(e));
    this.elements.urlInput.addEventListener('keydown', (e) => this.handleUrlKeydown(e));
    this.elements.urlInput.addEventListener('focus', () => this.showSuggestions());
    this.elements.urlInput.addEventListener('blur', () => setTimeout(() => this.hideSuggestions(), 200));

    // Settings menu with proper positioning
    this.elements.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isActive = this.elements.settingsMenu.classList.contains('active');
      
      if (!isActive) {
        // Position menu relative to button
        const rect = this.elements.settingsBtn.getBoundingClientRect();
        this.elements.settingsMenu.style.top = `${rect.bottom + 4}px`;
        this.elements.settingsMenu.classList.add('active');
      } else {
        this.elements.settingsMenu.classList.remove('active');
      }
    });

    // Prevent menu from closing when clicking inside inputs
    this.elements.settingsMenu.addEventListener('click', (e) => {
      // Only stop propagation if clicking on inputs or no-hover items
      if (e.target.tagName === 'INPUT' || e.target.closest('.no-hover')) {
        e.stopPropagation();
      }
    });

    this.elements.startStreamOption.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startStream();
      this.elements.settingsMenu.classList.remove('active');
    });

    this.elements.stopStreamOption.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stopStream();
      this.elements.settingsMenu.classList.remove('active');
    });

    // Fast input handling with validation
    this.elements.fpsInput.addEventListener('input', (e) => {
      let value = parseInt(e.target.value);
      if (value < 10) value = 10;
      if (value > 30) value = 30;
      e.target.value = value;
    });

    this.elements.qualityInput.addEventListener('input', (e) => {
      let value = parseInt(e.target.value);
      if (value < 50) value = 50;
      if (value > 90) value = 90;
      e.target.value = value;
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.elements.settingsBtn.contains(e.target) && 
          !this.elements.settingsMenu.contains(e.target)) {
        this.elements.settingsMenu.classList.remove('active');
      }
    });

    // Stream interactions - optimized for better performance
    this.elements.stream.addEventListener('click', (e) => this.handleClick(e), { passive: false });
    this.elements.stream.addEventListener('wheel', (e) => this.handleScroll(e), { passive: false });
    this.elements.stream.addEventListener('contextmenu', (e) => e.preventDefault());
    
    // Keyboard events
    document.addEventListener('keydown', (e) => this.handleKeyboard(e));
  }

  handleUrlInput(e) {
    const value = e.target.value.trim();
    
    if (value.length === 0) {
      this.hideSuggestions();
      return;
    }

    // Clear previous timeout
    if (this.inputDebounceTimeout) {
      clearTimeout(this.inputDebounceTimeout);
    }

    // Show suggestions immediately but debounce the update
    this.showSuggestions();
    
    this.inputDebounceTimeout = setTimeout(() => {
      this.updateSuggestions(value);
    }, this.inputDebounceDelay);
  }

  handleUrlKeydown(e) {
    const suggestionsEl = document.getElementById('suggestions');
    const items = suggestionsEl.querySelectorAll('.suggestion-item');
    
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        const active = suggestionsEl.querySelector('.suggestion-item.active');
        if (active) {
          this.navigate(active.dataset.url);
        } else {
          this.navigate(this.elements.urlInput.value);
        }
        this.hideSuggestions();
        break;
        
      case 'ArrowDown':
        e.preventDefault();
        this.highlightSuggestion(1);
        break;
        
      case 'ArrowUp':
        e.preventDefault();
        this.highlightSuggestion(-1);
        break;
        
      case 'Escape':
        e.preventDefault();
        this.hideSuggestions();
        break;
    }
  }

  updateSuggestions(query) {
    const suggestionsEl = document.getElementById('suggestions');
    const commonSites = [
      { name: 'Google', url: 'https://www.google.com' },
      { name: 'YouTube', url: 'https://www.youtube.com' },
      { name: 'Wikipedia', url: 'https://www.wikipedia.org' },
      { name: 'GitHub', url: 'https://www.github.com' },
      { name: 'Stack Overflow', url: 'https://stackoverflow.com' },
      { name: 'Reddit', url: 'https://www.reddit.com' },
      { name: 'Amazon', url: 'https://www.amazon.com' },
      { name: 'Gmail', url: 'https://mail.google.com' },
      { name: 'Facebook', url: 'https://www.facebook.com' },
      { name: 'Twitter', url: 'https://twitter.com' }
    ];

    const lowerQuery = query.toLowerCase();
    
    // Filter suggestions
    const filtered = commonSites.filter(site => 
      site.name.toLowerCase().includes(lowerQuery) ||
      site.url.includes(query)
    ).slice(0, 8);

    // Add search option
    const suggestions = [
      {
        name: `Search Google for "${query}"`,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        type: 'search'
      },
      ...filtered.map(site => ({ ...site, type: 'site' }))
    ];

    suggestionsEl.innerHTML = suggestions.map((s, idx) => `
      <div class="suggestion-item" data-url="${s.url}" data-index="${idx}">
        <svg class="suggestion-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          ${s.type === 'search' ? 
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>' :
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.658 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path>'
          }
        </svg>
        <span class="suggestion-text">${s.name}</span>
        <span class="suggestion-type">${s.type === 'search' ? 'Search' : 'Site'}</span>
      </div>
    `).join('');

    // Add click handlers
    suggestionsEl.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', () => {
        this.navigate(item.dataset.url);
        this.hideSuggestions();
      });
    });
  }

  highlightSuggestion(direction) {
    const suggestionsEl = document.getElementById('suggestions');
    const items = Array.from(suggestionsEl.querySelectorAll('.suggestion-item'));
    const active = suggestionsEl.querySelector('.suggestion-item.active');
    
    if (items.length === 0) return;

    let nextIndex = 0;
    if (active) {
      const currentIndex = items.indexOf(active);
      nextIndex = Math.max(0, Math.min(currentIndex + direction, items.length - 1));
      active.classList.remove('active');
    }

    items[nextIndex].classList.add('active');
    items[nextIndex].scrollIntoView({ 
      block: 'nearest',
      behavior: 'smooth'
    });
  }

  showSuggestions() {
    document.getElementById('suggestions').classList.add('active');
  }

  hideSuggestions() {
    document.getElementById('suggestions').classList.remove('active');
  }

  showLoadingSpinner(text = 'Loading page...', subtext = 'This may take 10-30 seconds for heavy sites') {
    this.elements.loadingText.textContent = text;
    this.elements.loadingSubtext.textContent = subtext;
    this.elements.loadingSpinner.classList.add('active');
    this.elements.placeholder.style.display = 'none';
    this.elements.loadingBar.classList.add('active');
  }

  hideLoadingSpinner() {
    this.elements.loadingSpinner.classList.remove('active');
    this.elements.loadingBar.classList.remove('active');
  }

  updateProgressBar(percentage) {
    this.elements.loadingBar.style.width = `${Math.min(percentage, 100)}%`;
    if (!this.elements.loadingBar.classList.contains('active')) {
      this.elements.loadingBar.classList.add('active');
    }
  }

  showConnectionOverlay(title, subtitle) {
    this.elements.connectionTitle.textContent = title;
    this.elements.connectionSubtitle.textContent = subtitle;
    this.elements.connectionOverlay.classList.add('active');
  }

  hideConnectionOverlay() {
    this.elements.connectionOverlay.classList.remove('active');
  }

  handleClick(e) {
    if (!this.isStreaming) return;
    
    e.preventDefault();
    const rect = this.elements.stream.getBoundingClientRect();
    const scaleX = this.viewportWidth / rect.width;
    const scaleY = this.viewportHeight / rect.height;
    
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    this.sendInteraction({
      type: 'click',
      x,
      y,
      button: e.button === 2 ? 'right' : 'left'
    });
  }

  handleScroll(e) {
    if (!this.isStreaming) return;
    
    e.preventDefault();
    this.sendInteraction({
      type: 'scroll',
      deltaY: e.deltaY
    });
  }

  handleKeyboard(e) {
    if (e.target === this.elements.urlInput) return;

    const specialKeys = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    
    if (specialKeys.includes(e.key)) {
      e.preventDefault();
      this.sendInteraction({ type: 'key', key: e.key });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.sendInteraction({ type: 'type', text: e.key });
    }
  }

  navigate(url) {
    if (!url) return;

    const finalUrl = url.startsWith('http') ? url : 
                     url.includes('.') ? `https://${url}` : 
                     `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    
    this.elements.urlInput.value = finalUrl;

    if (!this.isStreaming) {
      this.startStream();
      return;
    }

    this.showLoadingSpinner('Navigating...', 'Loading new page');

    this.sendInteraction({
      type: 'navigate',
      action: 'goto',
      url: finalUrl
    });
  }

  sendInteraction(action) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionId) {
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'interact',
      sessionId: this.sessionId,
      action
    }));
  }

  connect() {
    if (this.connectionRetryTimeout) {
      clearTimeout(this.connectionRetryTimeout);
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    console.log(`🔌 Connecting to ${wsUrl}...`);
    
    try {
      this.ws = new WebSocket(wsUrl);
      // Enable binary type for better performance
      this.ws.binaryType = 'arraybuffer';
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.handleConnectionFailure();
      return;
    }

    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      this.reconnectAttempts = 0;
      this.updateStatus('connected', 'Connected');
      this.hideConnectionOverlay();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('❌ WebSocket disconnected');
      this.updateStatus('disconnected', 'Disconnected');
      
      if (this.isStreaming) {
        this.showConnectionOverlay('Connection Lost', 'Attempting to reconnect...');
      }
      
      this.handleConnectionFailure();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleConnectionFailure() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts);
      this.reconnectAttempts++;
      
      console.log(`⏳ Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      this.showConnectionOverlay(
        'Reconnecting...',
        `Attempt ${this.reconnectAttempts} of ${this.maxReconnectAttempts} - Please wait`
      );
      
      this.connectionRetryTimeout = setTimeout(() => this.connect(), delay);
    } else {
      console.error('❌ Max reconnection attempts reached');
      this.updateStatus('disconnected', 'Connection Failed');
      this.showConnectionOverlay(
        'Connection Failed',
        'Unable to connect to server. Please refresh the page to try again.'
      );
    }
  }

  handleMessage(data) {
    switch (data.type) {
      case 'started':
        this.sessionId = data.sessionId;
        this.isStreaming = true;
        console.log(`📹 Stream started with session ID: ${this.sessionId}`);
        this.updateStatus('streaming', 'Streaming');
        this.enableNavigation(true);
        this.elements.placeholder.style.display = 'none';
        this.elements.startStreamOption.style.display = 'none';
        this.elements.stopStreamOption.style.display = 'flex';
        this.updateProgressBar(10);
        this.showLoadingSpinner('Loading page...', 'Please wait, this may take up to 30 seconds');
        break;

      case 'progress':
        // Update progress bar based on server progress
        this.updateProgressBar(data.progress);
        if (data.message) {
          this.elements.loadingText.textContent = data.message;
        }
        if (data.subtext) {
          this.elements.loadingSubtext.textContent = data.subtext;
        }
        break;

      case 'frame':
        // Queue frame for smooth rendering
        this.queueFrame(data);
        break;

      case 'pageInfo':
        if (data.url) {
          this.elements.currentUrl.textContent = this.truncateUrl(data.url);
          this.elements.urlInput.value = data.url;
          this.elements.windowTitle.textContent = data.title || '🌐 Remote Browser';
        }
        break;

      case 'stopped':
        console.log('🛑 Stream stopped');
        this.resetStream();
        break;

      case 'error':
        console.error('Server error:', data.message);
        this.hideLoadingSpinner();
        this.updateProgressBar(0);
        this.elements.loadingBar.classList.remove('active');
        this.showNotification(`❌ ${data.message}`, 'error');
        break;
    }
  }

  queueFrame(data) {
    // Memory optimization: Keep queue small (max 3 frames)
    if (this.frameQueue.length >= 3) {
      // Drop oldest frame to prevent memory buildup
      this.frameQueue.shift();
    }
    
    // Add frame to queue
    this.frameQueue.push(data);
    
    // Start processing if not already processing
    if (!this.isProcessingFrame) {
      this.processNextFrame();
    }
  }

  processNextFrame() {
    if (this.frameQueue.length === 0) {
      this.isProcessingFrame = false;
      return;
    }

    this.isProcessingFrame = true;
    const data = this.frameQueue.shift();
    
    // No need to skip frames - queue is already limited to 3

    const now = performance.now();
    const timeSinceLastFrame = now - this.lastFrameTime;
    
    // Render immediately if enough time has passed, otherwise schedule
    if (timeSinceLastFrame >= this.targetFrameTime) {
      this.renderFrame(data);
      this.lastFrameTime = now;
      // Process next frame
      requestAnimationFrame(() => this.processNextFrame());
    } else {
      // Schedule for next frame
      const delay = this.targetFrameTime - timeSinceLastFrame;
      setTimeout(() => {
        this.renderFrame(data);
        this.lastFrameTime = performance.now();
        requestAnimationFrame(() => this.processNextFrame());
      }, delay);
    }
  }

  renderFrame(data) {
    // Decode base64 more efficiently without intermediate strings
    const byteCharacters = atob(data.frame);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    
    const blob = new Blob([byteNumbers], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    
    // Clean up previous object URL IMMEDIATELY to free memory
    const oldSrc = this.elements.stream.src;
    if (oldSrc && oldSrc.startsWith('blob:')) {
      URL.revokeObjectURL(oldSrc);
    }
    
    this.elements.stream.src = url;
    
    // Clear the data to help garbage collection
    byteNumbers.fill(0);
    
    // Update frame count
    this.frameCount++;
    this.fpsCounter++;
    this.elements.frameCountEl.textContent = this.frameCount;

    // Calculate FPS
    const now = Date.now();
    const elapsed = now - this.lastFpsUpdate;
    if (elapsed >= 1000) {
      const fps = Math.round((this.fpsCounter / elapsed) * 1000);
      this.elements.fpsDisplay.textContent = `${fps} FPS`;
      this.fpsCounter = 0;
      this.lastFpsUpdate = now;
    }

    // Calculate latency
    const latency = Date.now() - data.timestamp;
    this.elements.latency.textContent = `${latency}ms`;

    // Hide loading on first frame
    if (this.frameCount === 1) {
      this.hideLoadingSpinner();
      this.updateProgressBar(100);
      setTimeout(() => {
        this.elements.loadingBar.classList.remove('active');
      }, 300);
      this.elements.stream.classList.add('active');
    }
    
    // Force garbage collection hint every 100 frames
    if (this.frameCount % 100 === 0) {
      this.cleanupMemory();
    }
  }

  cleanupMemory() {
    // Clear frame queue if it's getting large
    if (this.frameQueue.length > 5) {
      console.log('🧹 Clearing frame queue to save memory');
      this.frameQueue = this.frameQueue.slice(-2); // Keep only last 2
    }
    
    // Suggest garbage collection (browser decides)
    if (window.gc && typeof window.gc === 'function') {
      window.gc();
    }
  }

  startStream() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showConnectionOverlay('Connecting...', 'Please wait while we connect to the server');
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.startStream();
        }
      }, 1000);
      return;
    }

    const url = this.elements.urlInput.value.trim() || 'https://www.google.com';
    const finalUrl = url.startsWith('http') ? url : 
                     url.includes('.') ? `https://${url}` : 
                     url;

    // Validate and clamp input values
    let fps = parseInt(this.elements.fpsInput.value) || 20;
    fps = Math.max(10, Math.min(fps, 30));
    this.elements.fpsInput.value = fps;

    let quality = parseInt(this.elements.qualityInput.value) || 65;
    quality = Math.max(50, Math.min(quality, 90));
    this.elements.qualityInput.value = quality;

    console.log(`🚀 Starting stream for ${finalUrl}`);
    console.log(`⚙️  Settings: ${fps} FPS, ${quality}% quality, ${this.viewportWidth}x${this.viewportHeight}`);

    try {
      this.ws.send(JSON.stringify({
        type: 'start',
        url: finalUrl,
        fps,
        quality,
        width: this.viewportWidth,
        height: this.viewportHeight
      }));

      this.frameCount = 0;
      this.fpsCounter = 0;
      this.lastFpsUpdate = Date.now();
      this.frameQueue = [];
      
      this.showLoadingSpinner(
        'Starting browser...',
        'Loading page, please wait'
      );
    } catch (error) {
      console.error('Failed to start stream:', error);
      this.showNotification('Failed to start stream. Please try again.', 'error');
    }
  }

  stopStream() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log('🛑 Stopping stream');
    this.ws.send(JSON.stringify({ type: 'stop' }));
    this.hideLoadingSpinner();
    this.frameQueue = [];
  }

  resetStream() {
    this.sessionId = null;
    this.isStreaming = false;
    
    // Clear frame queue and help GC
    this.frameQueue.forEach(frame => {
      if (frame && frame.frame) {
        frame.frame = null; // Clear base64 data
      }
    });
    this.frameQueue = [];
    
    this.enableNavigation(false);
    this.elements.stream.classList.remove('active');
    
    // Clean up object URL and clear image
    if (this.elements.stream.src && this.elements.stream.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.elements.stream.src);
    }
    this.elements.stream.src = '';
    
    this.elements.placeholder.style.display = 'block';
    this.hideLoadingSpinner();
    this.updateStatus('connected', 'Connected');
    this.elements.fpsDisplay.textContent = '0 FPS';
    this.elements.currentUrl.textContent = '-';
    this.elements.windowTitle.textContent = '🌐 Remote Browser';
    this.frameCount = 0;
    this.elements.startStreamOption.style.display = 'flex';
    this.elements.stopStreamOption.style.display = 'none';
    
    // Force memory cleanup
    this.cleanupMemory();
  }

  enableNavigation(enabled) {
    this.elements.backBtn.disabled = !enabled;
    this.elements.forwardBtn.disabled = !enabled;
    this.elements.refreshBtn.disabled = !enabled;
    this.elements.homeBtn.disabled = !enabled;
  }

  updateStatus(type, text) {
    this.elements.statusText.textContent = text;
    this.elements.statusDot.className = `status-dot ${type === 'connected' || type === 'streaming' ? '' : 'disconnected'}`;
  }

  truncateUrl(url) {
    const maxLength = 60;
    return url.length > maxLength ? url.substring(0, maxLength) + '...' : url;
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      padding: 16px 24px;
      background: ${type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6'};
      color: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 10000;
      font-size: 14px;
      max-width: 400px;
      animation: slideIn 0.3s ease;
      line-height: 1.5;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 5000);
  }
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(400px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(400px); opacity: 0; }
  }
`;
document.head.appendChild(style);

// Initialize client when page loads
document.addEventListener('DOMContentLoaded', () => {
  new RemoteBrowserClient();
});
