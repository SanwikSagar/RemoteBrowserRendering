class RemoteBrowserClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.frameCount = 0;
    this.fpsCounter = 0;
    this.lastFpsUpdate = Date.now();
    this.interactionMode = 'click';
    this.isStreaming = false;
    this.currentPageUrl = '';
    
    this.elements = {
      urlInput: document.getElementById('urlInput'),
      fpsInput: document.getElementById('fpsInput'),
      qualityInput: document.getElementById('qualityInput'),
      interactiveMode: document.getElementById('interactiveMode'),
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      goBtn: document.getElementById('goBtn'),
      backBtn: document.getElementById('backBtn'),
      forwardBtn: document.getElementById('forwardBtn'),
      refreshBtn: document.getElementById('refreshBtn'),
      homeBtn: document.getElementById('homeBtn'),
      stream: document.getElementById('stream'),
      viewer: document.getElementById('viewer'),
      placeholder: document.getElementById('placeholder'),
      toolbar: document.getElementById('toolbar'),
      clickTool: document.getElementById('clickTool'),
      scrollTool: document.getElementById('scrollTool'),
      status: document.getElementById('status'),
      currentUrl: document.getElementById('currentUrl'),
      currentFps: document.getElementById('currentFps'),
      frameCountEl: document.getElementById('frameCount'),
      latency: document.getElementById('latency')
    };

    this.setupEventListeners();
    this.connect();
  }

  setupEventListeners() {
    // Browser controls
    this.elements.startBtn.addEventListener('click', () => this.startStream());
    this.elements.stopBtn.addEventListener('click', () => this.stopStream());
    this.elements.goBtn.addEventListener('click', () => this.navigate());
    this.elements.backBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'back' }));
    this.elements.forwardBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'forward' }));
    this.elements.refreshBtn.addEventListener('click', () => this.sendInteraction({ type: 'navigate', action: 'reload' }));
    this.elements.homeBtn.addEventListener('click', () => {
      this.elements.urlInput.value = 'https://www.google.com';
      this.navigate();
    });
    
    // URL input
    this.elements.urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        if (this.isStreaming) {
          this.navigate();
        } else {
          this.startStream();
        }
      }
    });

    // Stream interactions
    this.elements.stream.addEventListener('click', (e) => this.handleClick(e));
    this.elements.stream.addEventListener('wheel', (e) => this.handleScroll(e), { passive: false });
    
    // Keyboard events for the viewer
    document.addEventListener('keydown', (e) => {
      if (this.isStreaming && this.elements.interactiveMode.checked) {
        this.handleKeyboard(e);
      }
    });

    // Tool selection
    this.elements.clickTool.addEventListener('click', () => this.setInteractionMode('click'));
    this.elements.scrollTool.addEventListener('click', () => this.setInteractionMode('scroll'));
  }

  setInteractionMode(mode) {
    this.interactionMode = mode;
    this.elements.clickTool.classList.toggle('active', mode === 'click');
    this.elements.scrollTool.classList.toggle('active', mode === 'scroll');
    this.elements.stream.style.cursor = mode === 'click' ? 'pointer' : 'grab';
  }

  handleClick(e) {
    if (!this.isStreaming || !this.elements.interactiveMode.checked) return;
    
    e.preventDefault();
    const rect = this.elements.stream.getBoundingClientRect();
    const scaleX = 1920 / rect.width;
    const scaleY = 1080 / rect.height;
    
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    // Visual feedback
    this.showClickIndicator(e.clientX, e.clientY);

    this.sendInteraction({
      type: 'click',
      x,
      y,
      button: e.button === 2 ? 'right' : 'left'
    });

    console.log(`🖱️ Click at (${x}, ${y})`);
  }

  handleScroll(e) {
    if (!this.isStreaming || !this.elements.interactiveMode.checked) return;
    
    e.preventDefault();
    const deltaY = e.deltaY;

    this.sendInteraction({
      type: 'scroll',
      deltaY: deltaY
    });

    console.log(`📜 Scroll: ${deltaY}`);
  }

  handleKeyboard(e) {
    // Only handle typing when focused on the viewer
    if (e.target === this.elements.urlInput) return;

    // Special keys
    const specialKeys = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    
    if (specialKeys.includes(e.key)) {
      e.preventDefault();
      this.sendInteraction({
        type: 'key',
        key: e.key
      });
      console.log(`⌨️ Key: ${e.key}`);
    } else if (e.key.length === 1) {
      // Regular character
      this.sendInteraction({
        type: 'type',
        text: e.key
      });
      console.log(`⌨️ Type: ${e.key}`);
    }
  }

  showClickIndicator(x, y) {
    const indicator = document.createElement('div');
    indicator.className = 'click-indicator';
    indicator.style.left = `${x - 10}px`;
    indicator.style.top = `${y - 10}px`;
    document.body.appendChild(indicator);
    
    setTimeout(() => indicator.remove(), 500);
  }

  navigate() {
    if (!this.isStreaming) {
      this.startStream();
      return;
    }

    const url = this.elements.urlInput.value.trim();
    if (!url) return;

    const finalUrl = url.startsWith('http') ? url : `https://${url}`;
    
    this.sendInteraction({
      type: 'navigate',
      action: 'goto',
      url: finalUrl
    });

    console.log(`🧭 Navigate to: ${finalUrl}`);
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
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      this.updateStatus('connected', 'Connected');
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
      this.isStreaming = false;
      
      // Attempt reconnection after 3 seconds
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleMessage(data) {
    switch (data.type) {
      case 'started':
        this.sessionId = data.sessionId;
        this.isStreaming = true;
        console.log(`📹 Stream started with session ID: ${this.sessionId}`);
        this.updateStatus('streaming', 'Streaming');
        this.elements.startBtn.disabled = true;
        this.elements.stopBtn.disabled = false;
        this.elements.goBtn.disabled = false;
        this.elements.backBtn.disabled = false;
        this.elements.forwardBtn.disabled = false;
        this.elements.refreshBtn.disabled = false;
        this.elements.homeBtn.disabled = false;
        this.elements.placeholder.style.display = 'none';
        this.elements.stream.classList.add('active');
        this.elements.toolbar.classList.add('active');
        this.currentPageUrl = this.elements.urlInput.value;
        this.elements.currentUrl.textContent = this.currentPageUrl;
        break;

      case 'frame':
        this.renderFrame(data);
        break;

      case 'pageInfo':
        if (data.url) {
          this.currentPageUrl = data.url;
          this.elements.currentUrl.textContent = data.url;
          this.elements.urlInput.value = data.url;
        }
        break;

      case 'stopped':
        console.log('🛑 Stream stopped');
        this.resetStream();
        break;

      case 'error':
        console.error('Server error:', data.message);
        alert(`Error: ${data.message}`);
        this.resetStream();
        break;
    }
  }

  renderFrame(data) {
    // Preload image before displaying for smoother rendering
    const img = new Image();
    img.onload = () => {
      this.elements.stream.src = img.src;
      
      // Update frame count
      this.frameCount++;
      this.fpsCounter++;
      this.elements.frameCountEl.textContent = this.frameCount;

      // Calculate FPS
      const now = Date.now();
      const elapsed = now - this.lastFpsUpdate;
      if (elapsed >= 1000) {
        const fps = Math.round((this.fpsCounter / elapsed) * 1000);
        this.elements.currentFps.textContent = fps;
        this.fpsCounter = 0;
        this.lastFpsUpdate = now;
      }

      // Calculate latency
      const latency = Date.now() - data.timestamp;
      this.elements.latency.textContent = `${latency}ms`;
    };
    
    img.src = `data:image/jpeg;base64,${data.frame}`;
  }

  startStream() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      alert('WebSocket not connected. Please wait...');
      return;
    }

    const url = this.elements.urlInput.value.trim();
    if (!url) {
      alert('Please enter a URL');
      return;
    }

    // Ensure URL has protocol
    const finalUrl = url.startsWith('http') ? url : `https://${url}`;

    const fps = parseInt(this.elements.fpsInput.value) || 60;
    const quality = parseInt(this.elements.qualityInput.value) || 85;

    console.log(`🚀 Starting stream for ${finalUrl}`);

    this.ws.send(JSON.stringify({
      type: 'start',
      url: finalUrl,
      fps,
      quality,
      width: 1920,
      height: 1080
    }));

    this.frameCount = 0;
    this.fpsCounter = 0;
    this.lastFpsUpdate = Date.now();
  }

  stopStream() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log('🛑 Stopping stream');
    this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  resetStream() {
    this.sessionId = null;
    this.isStreaming = false;
    this.elements.startBtn.disabled = false;
    this.elements.stopBtn.disabled = true;
    this.elements.goBtn.disabled = true;
    this.elements.backBtn.disabled = true;
    this.elements.forwardBtn.disabled = true;
    this.elements.refreshBtn.disabled = true;
    this.elements.homeBtn.disabled = true;
    this.elements.stream.classList.remove('active');
    this.elements.toolbar.classList.remove('active');
    this.elements.placeholder.style.display = 'block';
    this.updateStatus('connected', 'Connected');
    this.elements.currentFps.textContent = '0';
    this.elements.currentUrl.textContent = '-';
    this.frameCount = 0;
  }

  updateStatus(type, text) {
    this.elements.status.textContent = text;
    this.elements.status.className = `status status-${type}`;
  }
}

// Initialize client when page loads
document.addEventListener('DOMContentLoaded', () => {
  new RemoteBrowserClient();
});
