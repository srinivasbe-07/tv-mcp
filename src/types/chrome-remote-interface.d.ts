/**
 * Local TypeScript declaration shim for `chrome-remote-interface`.
 *
 * Only needed if `@types/chrome-remote-interface` is unavailable or incomplete.
 * The official types should be preferred; this file declares just enough
 * surface area for our MCP server to compile cleanly.
 */
declare module 'chrome-remote-interface' {
  interface CDPTarget {
    id: string;
    title: string;
    url: string;
    type: string;
    webSocketDebuggerUrl?: string;
    description?: string;
    devtoolsFrontendUrl?: string;
  }

  interface CDPOptions {
    host?: string;
    port?: number;
    target?: string | CDPTarget | ((targets: CDPTarget[]) => CDPTarget);
    secure?: boolean;
  }

  interface CDPClient {
    close(): Promise<void>;
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    Runtime: {
      enable(): Promise<void>;
      evaluate(params: {
        expression: string;
        awaitPromise?: boolean;
        returnByValue?: boolean;
      }): Promise<{ result: { value?: unknown; type: string }; exceptionDetails?: unknown }>;
    };
    Page: {
      enable(): Promise<void>;
      captureScreenshot(params?: {
        format?: 'png' | 'jpeg';
        quality?: number;
        fromSurface?: boolean;
      }): Promise<{ data: string }>;
    };
    [key: string]: unknown;
  }

  function CDP(options?: CDPOptions): Promise<CDPClient>;

  namespace CDP {
    function List(options?: { host?: string; port?: number }): Promise<CDPTarget[]>;
    function New(options?: { host?: string; port?: number; url?: string }): Promise<CDPTarget>;
    function Close(options?: { host?: string; port?: number; id: string }): Promise<void>;
    function Version(options?: { host?: string; port?: number }): Promise<Record<string, string>>;
  }

  export = CDP;
}
