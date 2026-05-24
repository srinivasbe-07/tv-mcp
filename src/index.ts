/**
 * tv-mcp
 * Minimal MCP server that connects to TradingView Desktop via Chrome DevTools Protocol.
 *
 * Prerequisite: Launch TradingView Desktop with --remote-debugging-port=9222
 * (use the bundled launch-tv.bat script).
 *
 * v0.1 - single tool: tv_health_check
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// chrome-remote-interface is a CommonJS module, so default-import works in ES modules
// thanks to esModuleInterop being enabled in tsconfig.
import CDP from "chrome-remote-interface";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CDP_PORT = 9222;
const CDP_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// CDP helper: list debuggable targets running on the TradingView app
// ---------------------------------------------------------------------------
interface CdpTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(): Promise<CdpTarget[]> {
  // CDP.List hits http://localhost:9222/json and returns the list of debuggable pages.
  const targets = (await CDP.List({
    host: CDP_HOST,
    port: CDP_PORT,
  })) as unknown as CdpTarget[];
  return targets;
}

// Find the most likely TradingView chart window among CDP targets.
// TradingView Desktop loads tradingview.com inside its Electron shell.
function findTradingViewTarget(targets: CdpTarget[]): CdpTarget | undefined {
  return targets.find(
    (t) =>
      t.type === "page" &&
      (t.url.includes("tradingview.com") ||
        t.title.toLowerCase().includes("tradingview"))
  );
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "tv-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Advertise our tools to Claude
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "tv_health_check",
      description:
        "Verify connection to TradingView Desktop via Chrome DevTools Protocol on port 9222. " +
        "Returns the active chart's URL, title, and target ID if successful. " +
        "Fails with a helpful message if TradingView is not running with the debug flag.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// Handle tool invocations from Claude
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "tv_health_check") {
    try {
      const targets = await listTargets();
      const tv = findTradingViewTarget(targets);

      if (!tv) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Connected to CDP on port ${CDP_PORT}, but no TradingView chart target was found.\n` +
                `Make sure a chart is open in TradingView Desktop.\n\n` +
                `Targets visible:\n${targets
                  .map((t) => `  - [${t.type}] ${t.title} (${t.url})`)
                  .join("\n")}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `TradingView connection OK.\n` +
              `Title: ${tv.title}\n` +
              `URL:   ${tv.url}\n` +
              `ID:    ${tv.id}\n` +
              `Type:  ${tv.type}\n\n` +
              `Found ${targets.length} debuggable target(s) total.`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Failed to connect to TradingView on ${CDP_HOST}:${CDP_PORT}.\n` +
              `Error: ${msg}\n\n` +
              `Checklist:\n` +
              `  1. Is TradingView Desktop running?\n` +
              `  2. Was it launched with --remote-debugging-port=${CDP_PORT}?\n` +
              `     Use the bundled launch-tv.bat script if unsure.\n` +
              `  3. Is anything else blocking port ${CDP_PORT}?`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start the server over stdio (Claude Code connects to us this way)
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr so we don't pollute the stdio MCP channel
process.stderr.write("tv-mcp v0.1.0 ready\n");
