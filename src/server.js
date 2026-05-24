#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CDPManager } from "./cdp.js";
import { ChartTools } from "./tools/chart.js";
import { PineTools } from "./tools/pine.js";
import { AlertTools } from "./tools/alerts.js";
import { UtilityTools } from "./tools/utility.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(process.cwd(), "tradingview-mcp.log");

// Logging utility
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}${data ? ` | ${JSON.stringify(data)}` : ""}\n`;
  process.stderr.write(logEntry);
  try {
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (e) {
    // Silently fail if we can't write to log file
  }
}

class TradingViewMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: "tradingview-mcp",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.cdp = new CDPManager();
    this.chartTools = new ChartTools(this.cdp);
    this.pineTools = new PineTools(this.cdp);
    this.alertTools = new AlertTools(this.cdp);
    this.utilityTools = new UtilityTools(this.cdp);

    this.setupHandlers();
    this.setupGracefulShutdown();
  }

  setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
        ...this.chartTools.getTools(),
        ...this.pineTools.getTools(),
        ...this.alertTools.getTools(),
        ...this.utilityTools.getTools(),
      ];

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      log(`Tool called: ${name}`, args);

      try {
        // Ensure CDP connection
        if (!this.cdp.isConnected()) {
          log("CDP not connected, attempting to connect...");
          try {
            await this.cdp.connect();
            log("CDP connection established");
          } catch (error) {
            return this.errorResponse(
              `Failed to connect to TradingView: ${error.message}`
            );
          }
        }

        // Route to appropriate tool handler
        let result = null;

        if (name.startsWith("chart_")) {
          result = await this.chartTools.handle(name, args);
        } else if (name.startsWith("pine_")) {
          result = await this.pineTools.handle(name, args);
        } else if (name.startsWith("alert_")) {
          result = await this.alertTools.handle(name, args);
        } else if (name.startsWith("tv_")) {
          result = await this.utilityTools.handle(name, args);
        } else {
          return this.errorResponse(`Unknown tool: ${name}`);
        }

        log(`Tool result: ${name} completed successfully`);
        return result;
      } catch (error) {
        log(`Tool error: ${name}`, { error: error.message });
        return this.errorResponse(`Tool error: ${error.message}`);
      }
    });

    // Error handler
    this.server.onerror = (error) => {
      log("Server error", { error: error.message, stack: error.stack });
    };
  }

  setupGracefulShutdown() {
    process.on("SIGINT", async () => {
      log("Received SIGINT, shutting down gracefully...");
      try {
        await this.cdp.disconnect();
        log("CDP connection closed");
      } catch (error) {
        log("Error closing CDP connection", { error: error.message });
      }
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      log("Received SIGTERM, shutting down gracefully...");
      try {
        await this.cdp.disconnect();
        log("CDP connection closed");
      } catch (error) {
        log("Error closing CDP connection", { error: error.message });
      }
      process.exit(0);
    });
  }

  errorResponse(message) {
    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: true,
    };
  }

  successResponse(data) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  async run() {
    log("Starting TradingView MCP Server v0.1.0");
    log("Waiting for MCP client connection...");

    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      log("MCP client connected successfully");
    } catch (error) {
      log("Failed to start server", { error: error.message });
      process.exit(1);
    }
  }
}

// Start server
const server = new TradingViewMCPServer();
server.run().catch((error) => {
  log("Fatal error during startup", { error: error.message });
  process.exit(1);
});
