import puppeteer from 'puppeteer';

export class BrowserPool {
  constructor(options = {}) {
    this.maxBrowsers = options.maxBrowsers || 5;
    this.launchOptions = options.launchOptions || {};
    this.availableBrowsers = [];
    this.busyBrowsers = new Set();
  }

  async initialize() {
    console.log(`🌐 Initializing browser pool with ${this.maxBrowsers} browsers...`);
    const promises = [];
    for (let i = 0; i < this.maxBrowsers; i++) {
      promises.push(this.createBrowser());
    }
    await Promise.all(promises);
    console.log(`✅ Browser pool initialized`);
  }

  async createBrowser() {
    try {
      const browser = await puppeteer.launch(this.launchOptions);
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
    const allBrowsers = [...this.availableBrowsers, ...this.busyBrowsers];
    await Promise.all(allBrowsers.map(browser => browser.close()));
    this.availableBrowsers = [];
    this.busyBrowsers.clear();
    console.log('✅ Browser pool cleaned up');
  }
}
