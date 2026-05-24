import CDP from 'chrome-remote-interface';

export class CDPManager {
  constructor() {
    this.client = null;
    this.connected = false;
    this.port = 9222; // Default Chrome DevTools Protocol port
    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryDelay = 1000; // ms
  }

  isConnected() {
    return this.connected && this.client !== null;
  }

  async connect() {
    if (this.isConnected()) {
      return;
    }

    try {
      this.client = await CDP({
        port: this.port,
      });

      // Enable necessary CDP domains
      const { Page, Runtime, DOM } = this.client;

      await Promise.all([Page?.enable?.(), Runtime?.enable?.(), DOM?.enable?.()].filter(Boolean));

      this.connected = true;
      this.retryCount = 0;

      console.error(`[CDP] Connected to Chrome DevTools Protocol on port ${this.port}`);
    } catch (error) {
      console.error(`[CDP] Connection failed: ${error.message}`);

      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        console.error(`[CDP] Retrying (${this.retryCount}/${this.maxRetries})...`);
        await this.delay(this.retryDelay);
        return this.connect();
      }

      throw new Error(
        `Failed to connect to Chrome DevTools Protocol on port ${this.port} ` +
          `after ${this.maxRetries} attempts. ` +
          `Ensure TradingView is running with --remote-debugging-port=${this.port}`
      );
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
        this.client = null;
        this.connected = false;
        console.error('[CDP] Connection closed');
      } catch (error) {
        console.error(`[CDP] Error closing connection: ${error.message}`);
      }
    }
  }

  /**
   * Execute JavaScript in the TradingView context
   * @param {string} expression - JavaScript expression to execute
   * @param {boolean} returnByValue - Return primitive value or object reference
   * @returns {Promise<any>} - Result of expression
   */
  async executeScript(expression, returnByValue = true) {
    if (!this.client) {
      throw new Error('CDP not connected');
    }

    try {
      const { Runtime } = this.client;
      const result = await Runtime.evaluate({
        expression,
        returnByValue,
      });

      if (result.exceptionDetails) {
        throw new Error(`Script execution error: ${result.exceptionDetails.text}`);
      }

      return result.result.value;
    } catch (error) {
      console.error(`[CDP] Script execution failed: ${error.message}`, expression);
      throw error;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url) {
    if (!this.client) {
      throw new Error('CDP not connected');
    }

    try {
      const { Page } = this.client;
      const response = await Page.navigate({ url });
      await Page.loadEventFired();
      return response;
    } catch (error) {
      console.error(`[CDP] Navigation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Wait for an element to appear on the page
   */
  async waitForElement(selector, timeoutMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const exists = await this.executeScript(`document.querySelector('${selector}') !== null`);
        if (exists) {
          return true;
        }
      } catch (error) {
        // Ignore errors and retry
      }

      await this.delay(100);
    }

    return false;
  }

  /**
   * Get page title
   */
  async getPageTitle() {
    return this.executeScript('document.title');
  }

  /**
   * Get current URL
   */
  async getCurrentUrl() {
    return this.executeScript('window.location.href');
  }

  /**
   * Take a screenshot
   */
  async takeScreenshot(region = 'chart') {
    if (!this.client) {
      throw new Error('CDP not connected');
    }

    try {
      const { Page } = this.client;
      const screenshot = await Page.captureScreenshot({
        format: 'png',
      });

      return {
        data: screenshot.data,
        type: 'png',
      };
    } catch (error) {
      console.error(`[CDP] Screenshot failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * TradingView specific: Get chart data
   */
  async getTradingViewChartData() {
    const script = `
      (function() {
        try {
          const widget = window.TradingView?.widget;
          if (!widget) return { error: "TradingView widget not found" };

          return {
            title: document.title,
            status: "connected",
            timestamp: new Date().toISOString(),
          };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `;

    return this.executeScript(script);
  }

  /**
   * Sleep utility
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
