import puppeteer from 'puppeteer';

export class BrowserPool {
  constructor(options = {}) {
    this.maxBrowsers = options.maxBrowsers || 5;
    this.launchOptions = options.launchOptions || {};
    this.availableBrowsers = [];
    this.busyBrowsers = new Set();
    this.memoryMonitorInterval = null;
  }

  async initialize() {
    console.log(`🌐 Initializing browser pool with ${this.maxBrowsers} browsers...`);
    const promises = [];
    for (let i = 0; i < this.maxBrowsers; i++) {
      promises.push(this.createBrowser());
    }
    await Promise.all(promises);
    console.log(`✅ Browser pool initialized`);
    
    // Start memory monitoring
    this.startMemoryMonitoring();
  }

  startMemoryMonitoring() {
    // Monitor memory every 30 seconds
    this.memoryMonitorInterval = setInterval(() => {
      const usage = process.memoryUsage();
      const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      
      console.log(`📊 Memory: Heap ${heapUsedMB}/${heapTotalMB}MB | RSS ${rssMB}MB`);
      
      // Trigger garbage collection if heap usage is high
      if (heapUsedMB > 400 && global.gc) {
        console.log('🧹 Running garbage collection...');
        global.gc();
      }
    }, 30000);
  }

  stopMemoryMonitoring() {
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
    }
  }

  async createBrowser() {
    try {
      // Memory-optimized launch options
      const browser = await puppeteer.launch({
        ...this.launchOptions,
        args: [
          ...(this.launchOptions.args || []),
          // Memory optimization flags
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-accelerated-2d-canvas',
          '--disable-gl-drawing-for-tests',
          '--disable-software-rasterizer',
          // Reduce memory usage
          '--disable-extensions',
          '--disable-plugins',
          '--disable-images', // We only need content, not display
          '--disable-javascript-harmony-shipping',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--disable-sync',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          '--disable-notifications',
          // Memory limits
          '--max-old-space-size=512', // Limit V8 heap to 512MB
          '--js-flags=--max-old-space-size=512',
        ]
      });
      
      this.availableBrowsers.push(browser);
      return browser;
    } catch (error) {
      console.error('Failed to create browser:', error);
      throw error;
    }
  }

  async acquire() {
    if (this.availableBrowsers.length === 0) {
      if (this.busyBrowsers.size < this.maxBrowsers) {
        await this.createBrowser();
      } else {
        // Wait for a browser to become available
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.acquire();
      }
    }

    const browser = this.availableBrowsers.pop();
    this.busyBrowsers.add(browser);
    return browser;
  }

  release(browser) {
    this.busyBrowsers.delete(browser);
    this.availableBrowsers.push(browser);
  }

  async cleanup() {
    console.log('🧹 Cleaning up browser pool...');
    
    // Stop memory monitoring
    this.stopMemoryMonitoring();
    
    const allBrowsers = [...this.availableBrowsers, ...this.busyBrowsers];
    await Promise.all(allBrowsers.map(browser => browser.close()));
    this.availableBrowsers = [];
    this.busyBrowsers.clear();
    
    // Force garbage collection
    if (global.gc) {
      global.gc();
    }
    
    console.log('✅ Browser pool cleaned up');
  }
}
