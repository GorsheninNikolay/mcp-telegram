#!/usr/bin/env node

// Redirect console.log to stderr BEFORE any imports.
// GramJS Logger uses console.log (stdout) which corrupts MCP JSON-RPC stream.
console.log = (...args: unknown[]) => {
  console.error(...args);
};

import { createRequire } from "node:module";
import { tryAcquireLock } from "./lock.js";
import { loadApiCredentials } from "./session-store.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

let API_ID = 0;
let API_HASH = "";
async function requireCreds(): Promise<void> {
  const credentials = await loadApiCredentials();
  API_ID = credentials.apiId;
  API_HASH = credentials.apiHash;
}

async function main() {
  // Persistent daemon mode: `mcp-telegram serve` (or MCP_TELEGRAM_DAEMON=1). The daemon owns
  // the connection with no stdio attached; every other process becomes a client.
  if (process.argv[2] === "serve" || process.env.MCP_TELEGRAM_DAEMON === "1") {
    await requireCreds();
    console.error("[mcp-telegram] Starting in serve (daemon) mode");
    const { runServe } = await import("./serve.js");
    await runServe(API_ID, API_HASH as string, version);
    return;
  }

  if (process.argv[2] === "client") {
    const { runClient } = await import("./client.js");
    await runClient(0, "", version);
    return;
  }
  const isMaster = await tryAcquireLock();

  if (isMaster) {
    await requireCreds();
    console.error("[mcp-telegram] Starting as master process");
    const { runMaster } = await import("./master.js");
    await runMaster(API_ID, API_HASH as string, version);
  } else {
    // Client proxies all tool calls to the owner over IPC; the dummy TelegramService is
    // never used for real calls, so API credentials are optional here.
    console.error("[mcp-telegram] Starting as client process (owner already running)");
    const { runClient } = await import("./client.js");
    await runClient(API_ID || 0, API_HASH ?? "", version);
  }
}

main().catch((err) => {
  console.error("[mcp-telegram] Startup failed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
