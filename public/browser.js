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
    this.connect();
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
    
    // URL input
    this.elements.urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const url = this.elements.urlInput.value.trim();
        this.navigate(url);
      }
    });

    // Settings menu
    this.elements.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.elements.settingsMenu.classList.toggle('active');
    });

    this.elements.startStreamOption.addEventListener('click', () => {
      this.startStream();
      this.elements.settingsMenu.classList.remove('active');
    });

    this.elements.stopStreamOption.addEventListener('click', () => {
      this.stopStream();
      this.elements.settingsMenu.classList.remove('active');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.elements.settingsBtn.contains(e.target)) {
        this.elements.settingsMenu.classList.remove('active');
      }
    });

    // Stream interactions
    this.elements.stream.addEventListener('click', (e) => this.handleClick(e));
    this.elements.stream.addEventListener('wheel', (e) => this.handleScroll(e), { passive: false });
    this.elements.stream.addEventListener('contextmenu', (e) => e.preventDefault());
    
    // Keyboard events
    document.addEventListener('keydown', (e) => {
      if (this.isStreaming && e.target !== this.elements.urlInput) {
        this.handleKeyboard(e);
      }
    });
  }

  handleClick(e) {
    if (!this.isStreaming) return;
    
    e.preventDefault();
    const rect = this.elements.stream.getBoundingClientRect();
    const scaleX = 1280 / rect.width;  // Match server viewport width
    const scaleY = 720 / rect.height;   // Match server viewport height
    
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    this.sendInteraction({
      type: 'click',
      x,
      y,
      button: e.button === 2 ? 'right' : 'left'
    });

    console.log(`🖱️ Click at (${x}, ${y})`);
  }

  handleScroll(e) {
    if (!this.isStreaming) return;
    
    e.preventDefault();
    const deltaY = e.deltaY;

    this.sendInteraction({
      type: 'scroll',
      deltaY: deltaY
    });
  }

  handleKeyboard(e) {
    if (e.target === this.elements.urlInput) return;

    // Special keys
    const specialKeys = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    
    if (specialKeys.includes(e.key)) {
      e.preventDefault();
      this.sendInteraction({
        type: 'key',
        key: e.key
      });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.sendInteraction({
        type: 'type',
        text: e.key
      });
    }
  }

  navigate(url) {
    if (!url) return;

    const finalUrl = url.startsWith('http') ? url : 
                     url.includes('.') ? `https://${url}` : 
                     `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    
    if (!this.isStreaming) {
      this.elements.urlInput.value = finalUrl;
      this.startStream();
      return;
    }

    this.elements.loadingBar.classList.add('active');
    this.elements.urlInput.value = finalUrl;

    this.sendInteraction({
      type: 'navigate',
      action: 'goto',
      url: finalUrl
    });

    setTimeout(() => {
      this.elements.loadingBar.classList.remove('active');
    }, 2000);

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
    
    console.log(`🔌 Connecting to ${wsUrl}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      this.reconnectAttempts = 0;
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
      
      // Attempt reconnection with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
        this.reconnectAttempts++;
        console.log(`⏳ Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        setTimeout(() => this.connect(), delay);
      } else {
        console.error('❌ Max reconnection attempts reached');
        this.updateStatus('disconnected', 'Connection failed');
      }
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
        this.enableNavigation(true);
        this.elements.placeholder.style.display = 'none';
        this.elements.stream.classList.add('active');
        this.elements.loadingBar.classList.add('active');
        this.elements.startStreamOption.style.display = 'none';
        this.elements.stopStreamOption.style.display = 'flex';
        setTimeout(() => {
          this.elements.loadingBar.classList.remove('active');
        }, 2000);
        break;

      case 'frame':
        this.renderFrame(data);
        break;

      case 'pageInfo':
        if (data.url) {
          this.elements.currentUrl.textContent = this.truncateUrl(data.url);
          this.elements.urlInput.value = data.url;
          this.elements.windowTitle.textContent = data.title || data.url;
        }
        break;

      case 'stopped':
        console.log('🛑 Stream stopped');
        this.resetStream();
        break;

      case 'error':
        console.error('Server error:', data.message);
        if (data.message.includes('timeout') || data.message.includes('Navigation')) {
          this.showNotification('⚠️ Page loading timeout - Try a simpler page or wait and retry', 'warning');
        } else {
          this.showNotification(`❌ Error: ${data.message}`, 'error');
        }
        break;
    }
  }

  renderFrame(data) {
    // Use object URL for better performance
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
        this.elements.fpsDisplay.textContent = `${fps} FPS`;
        this.fpsCounter = 0;
        this.lastFpsUpdate = now;
      }

      // Calculate latency
      const latency = Date.now() - data.timestamp;
      this.elements.latency.textContent = `${latency}ms`;
    };
    
    img.onerror = () => {
      console.error('Failed to load frame');
    };
    
    img.src = `data:image/jpeg;base64,${data.frame}`;
  }

  startStream() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showNotification('⏳ Connecting to server...', 'info');
      setTimeout(() => this.startStream(), 1000);
      return;
    }

    const url = this.elements.urlInput.value.trim() || 'https://www.google.com';
    const finalUrl = url.startsWith('http') ? url : `https://${url}`;

    const fps = parseInt(this.elements.fpsInput.value) || 30;
    const quality = parseInt(this.elements.qualityInput.value) || 70;

    console.log(`🚀 Starting stream for ${finalUrl}`);
    console.log(`⚙️  Settings: ${fps} FPS, ${quality}% quality`);

    this.ws.send(JSON.stringify({
      type: 'start',
      url: finalUrl,
      fps,
      quality,
      width: 1280,  // Optimized resolution
      height: 720
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
    this.enableNavigation(false);
    this.elements.stream.classList.remove('active');
    this.elements.placeholder.style.display = 'block';
    this.updateStatus('connected', 'Connected');
    this.elements.fpsDisplay.textContent = '0 FPS';
    this.elements.currentUrl.textContent = '-';
    this.elements.windowTitle.textContent = 'Remote Browser';
    this.frameCount = 0;
    this.elements.startStreamOption.style.display = 'flex';
    this.elements.stopStreamOption.style.display = 'none';
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
    const maxLength = 50;
    return url.length > maxLength ? url.substring(0, maxLength) + '...' : url;
  }

  showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      padding: 12px 20px;
      background: ${type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6'};
      color: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 10000;
      font-size: 14px;
      max-width: 400px;
      animation: slideIn 0.3s ease;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Auto remove after 4 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// Initialize client when page loads
document.addEventListener('DOMContentLoaded', () => {
  new RemoteBrowserClient();
});
