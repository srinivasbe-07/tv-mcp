import CDP from 'chrome-remote-interface';

export class CDPManager {
  /**
   * @param {string|null} targetId     - Connect to a specific CDP target by ID.
   *                                     Pass null to auto-probe for the active chart.
   * @param {string|null} registryFile - Path to per-monitor tab registry file.
   *                                     If set and the tab is closed, a new tab is
   *                                     created automatically and the registry updated.
   */
  constructor(targetId = null, registryFile = null) {
    this.client = null;
    this.connected = false;
    this.port = 9222;
    this.targetId = targetId;
    this.registryFile = registryFile;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * Probes all CDP targets and returns chart targets with their current symbol.
   * @returns {Promise<Array<{id, symbol, timeframe}>>}
   */
  static async probeChartTargets(port = 9222) {
    const targets = await CDP.List({ port });
    const chartTargets = targets.filter(
      (t) => (t.type === 'page' || t.type === 'webview') && t.url?.includes('tradingview.com')
    );
    const results = [];
    for (const t of chartTargets) {
      try {
        const probe = await CDP({ port, target: t.id });
        await probe.Runtime.enable();
        const { result } = await probe.Runtime.evaluate({
          expression: `(function() {
            const api = window.TradingViewApi;
            if (!api) return null;
            const widget = api._activeChartWidgetWV?._value;
            const chart  = api.activeChart?.();
            return {
              symbol:    widget?.symbol?.() || chart?.symbol?.() || null,
              timeframe: widget?.resolution?.() || chart?.resolution?.() || null,
            };
          })()`,
          returnByValue: true,
        });
        await probe.close();
        if (result?.value?.symbol) results.push({ id: t.id, ...result.value });
      } catch (_) {
        /* ignore */
      }
    }
    return results;
  }

  /**
   * Ensures a dedicated chart tab exists for a monitor.
   * Saves the tab ID in a per-monitor registry file so it survives restarts.
   * On restart (saved tab gone), claims the first live chart tab not already
   * owned by another monitor's registry file.
   *
   * @param {string}   registryFile   e.g. './logs/pattern-tab.json'
   * @param {number}   port
   * @param {string[]} otherRegistries  other monitors' registry files to avoid stealing their tab
   * @returns {Promise<string>} target ID to pass into new CDPManager(targetId)
   */
  static async ensureMonitorTab(registryFile, port = 9222, otherRegistries = []) {
    const fs = await import('fs');

    // Load saved tab ID from previous run
    let savedId = null;
    try {
      savedId = JSON.parse(fs.default.readFileSync(registryFile, 'utf8')).targetId;
    } catch (_) {
      /* ignore */
    }

    // Check if the saved tab is still alive
    const allTargets = await CDP.List({ port });
    const liveIds = new Set(allTargets.map((t) => t.id));
    if (savedId && liveIds.has(savedId)) {
      console.error(`[CDP] Reusing existing monitor tab ${savedId}`);
      return savedId;
    }

    // Collect tab IDs already claimed by other monitors
    const claimedIds = new Set();
    for (const reg of otherRegistries) {
      try {
        const id = JSON.parse(fs.default.readFileSync(reg, 'utf8')).targetId;
        if (id) claimedIds.add(id);
      } catch (_) {
        /* ignore */
      }
    }

    // Pick the first live chart tab not already owned by another monitor
    const chartTargets = allTargets.filter((t) => t.url?.includes('tradingview.com/chart'));
    const unclaimed = chartTargets.find((t) => !claimedIds.has(t.id));

    if (!unclaimed) {
      const need = otherRegistries.length + 1;
      throw new Error(
        `No unclaimed chart tab available — open ${need} chart tab(s) in TradingView (one per monitor)`
      );
    }

    // Save registry
    try {
      fs.default.mkdirSync('./logs', { recursive: true });
    } catch (_) {
      /* ignore */
    }
    fs.default.writeFileSync(registryFile, JSON.stringify({ targetId: unclaimed.id }, null, 2));
    console.error(`[CDP] Claimed chart tab for this monitor: ${unclaimed.id}`);
    return unclaimed.id;
  }

  isConnected() {
    return this.connected && this.client !== null;
  }

  async connect() {
    if (this.isConnected()) {
      return;
    }

    try {
      let target = this.targetId;

      // If we have a specific target, check it's still alive.
      // If the tab was closed and we have a registry file, create a new tab.
      if (target) {
        const allTargets = await CDP.List({ port: this.port }).catch(() => []);
        const alive = allTargets.some((t) => t.id === target);
        if (!alive) {
          if (this.registryFile) {
            console.error(`[CDP] Tab ${target.slice(0, 16)} was closed — creating new tab...`);
            target = await CDPManager.ensureMonitorTab(this.registryFile, this.port);
            this.targetId = target;
          } else {
            console.error(
              `[CDP] Tab ${target.slice(0, 16)} was closed — no registry file to recover`
            );
          }
        }
      }

      if (!target) {
        // Auto-probe: find the chart target with window.TradingViewApi active.
        const targets = await CDP.List({ port: this.port });
        const chartTargets = targets.filter(
          (t) => t.type === 'page' && t.url?.includes('tradingview.com/chart')
        );
        console.error(
          `[CDP] Found ${chartTargets.length} chart target(s) — probing for active API...`
        );
        for (const t of chartTargets) {
          try {
            const probe = await CDP({ port: this.port, target: t.id });
            await probe.Runtime.enable();
            const result = await probe.Runtime.evaluate({
              expression: 'typeof window.TradingViewApi !== "undefined"',
              returnByValue: true,
            });
            await probe.close();
            if (result?.result?.value === true) {
              target = t.id;
              console.error(`[CDP] Active chart API found on target ${t.id}`);
              break;
            }
          } catch (_) {
            /* ignore */
          }
        }
        if (!target && chartTargets.length > 0) {
          target = chartTargets[0].id;
          console.error(`[CDP] No active API found — using first chart target`);
        }
      }

      this.client = await CDP({
        port: this.port,
        target,
      });

      // Enable necessary CDP domains
      const { Page, Runtime, DOM } = this.client;

      await Promise.all([Page?.enable?.(), Runtime?.enable?.(), DOM?.enable?.()].filter(Boolean));

      this.connected = true;
      this.retryCount = 0;

      // Mark disconnected if the WebSocket drops unexpectedly
      this.client.on('disconnect', () => {
        this.connected = false;
        this.client = null;
        console.error('[CDP] Connection lost');
      });

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
        awaitPromise: true,
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

  // Simulate a real hardware mouse click at screen coordinates via CDP Input API.
  // More reliable than JS element.click() for React synthetic event handlers.
  async clickAt(x, y) {
    const { Input } = this.client;
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // Move mouse to coordinates (triggers CSS :hover without clicking).
  async hoverAt(x, y) {
    const { Input } = this.client;
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  }

  // Simulate a right-click at screen coordinates.
  async rightClickAt(x, y) {
    const { Input } = this.client;
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  }

  // Insert text at the current focused element via CDP Input API.
  // Unlike keyDown+char+keyUp triplets, this does NOT cause React to double characters.
  async insertText(text) {
    const { Input } = this.client;
    await Input.insertText({ text });
  }

  // Dispatch a real key press (keyDown + keyUp) via CDP Input API.
  // modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift.
  async pressKey(key, code, keyCode, modifiers = 0) {
    const { Input } = this.client;
    const base = {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    };
    await Input.dispatchKeyEvent({ type: 'keyDown', ...base });
    await Input.dispatchKeyEvent({ type: 'keyUp', ...base });
  }

  // Focus a field, select-all (Ctrl+A), delete, and type `text` as REAL keystrokes
  // so React's controlled-input state actually updates (DOM .value alone is ignored
  // by React on save). Returns false if the element wasn't found.
  async clearAndType(selector, text) {
    const coords = await this.getElementCenter(selector).catch(() => null);
    if (!coords) return false;
    await this.clickAt(coords.x, coords.y);
    await this.delay(80);
    await this.pressKey('a', 'KeyA', 65, 2); // Ctrl+A — select all
    await this.delay(40);
    await this.pressKey('Delete', 'Delete', 46); // clear selection
    await this.delay(40);
    await this.insertText(String(text));
    await this.delay(80);
    return true;
  }

  // Get an element's center screen coordinates via CDP DOM API
  async getElementCenter(selector) {
    const { DOM } = this.client;
    const doc = await DOM.getDocument();
    const { nodeId } = await DOM.querySelector({ nodeId: doc.root.nodeId, selector });
    if (!nodeId) return null;
    const { model } = await DOM.getBoxModel({ nodeId });
    if (!model) return null;
    const [x1, y1, x2, y2, , , x4, y4] = model.border;
    return { x: (x1 + x2 + x4) / 3, y: (y1 + y2 + y4) / 3 };
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
      } catch (_error) {
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
  async takeScreenshot(_region = 'chart') {
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
