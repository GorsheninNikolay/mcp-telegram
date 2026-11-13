import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
import { z } from "zod";
import { type McpServerInternal, parseMessages } from "../ipc-protocol.js";
import { handleClient } from "../master.js";
import { TelegramService } from "../telegram-client.js";
import { applyToolPolicy, readToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";

class SocketStub extends EventEmitter {
  destroyed = false;
  responses: Array<Record<string, unknown>> = [];
  write(line: string) {
    this.responses.push(JSON.parse(line));
    this.emit("response");
    return true;
  }
}

async function call(server: McpServer, telegram: TelegramService, request: object) {
  const socket = new SocketStub();
  handleClient(socket as unknown as Socket, server as unknown as McpServerInternal, telegram);
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No IPC response")), 1000);
    socket.once("response", () => {
      clearTimeout(timer);
      resolve(socket.responses[0]);
    });
  });
  socket.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  return response;
}

const registry = (s: McpServer) => (s as unknown as McpServerInternal)._registeredTools;
const noTelegram = {} as TelegramService;

describe("fork security policy", () => {
  it("defaults to a small text-only registry; no auth, sends, downloads or account writes", () => {
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, noTelegram, readToolPolicy({}));
    assert.deepEqual(
      Object.keys(registry(server)).sort(),
      [
        "telegram-status",
        "telegram-list-chats",
        "telegram-search-chats",
        "telegram-get-chat-info",
        "telegram-read-messages",
        "telegram-search-messages",
        "telegram-get-replies",
        "telegram-get-message-link",
        "telegram-get-message-buttons",
      ].sort(),
    );
  });

  it("does not trust readOnlyHint on new tools", () => {
    const server = new McpServer({ name: "test", version: "1" });
    server.registerTool("future-file-writer", { annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
    applyToolPolicy(server, readToolPolicy({}));
    assert.deepEqual(Object.keys(registry(server)), []);
  });

  it("rejects misspelled modes and empty, symbolic or mixed-mode chat scopes", () => {
    for (const env of [
      { MCP_TELEGRAM_MODE: "readonly" },
      { MCP_TELEGRAM_ALLOWED_CHAT_IDS: "" },
      { MCP_TELEGRAM_ALLOWED_CHAT_IDS: "123," },
      { MCP_TELEGRAM_ALLOWED_CHAT_IDS: "@friend" },
      { MCP_TELEGRAM_MODE: "full", MCP_TELEGRAM_ALLOWED_CHAT_IDS: "123" },
    ])
      assert.throws(() => readToolPolicy(env));
  });

  it("blocks raw IPC calls to removed tools before touching Telegram", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, noTelegram, readToolPolicy({}));
    for (const tool of ["telegram-send-file", "telegram-download-media", "telegram-login", "telegram-logout"]) {
      const res = await call(server, noTelegram, { type: "tool", id: tool, tool, args: {} });
      assert.match(String(res.error), /Unknown tool/);
    }
  });

  it("enforces numeric chat IDs at the owner, not merely in client discovery", async () => {
    let connected = 0;
    const telegram = {
      ensureConnected: async () => {
        connected++;
        return false;
      },
    } as unknown as TelegramService;
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, telegram, readToolPolicy({ MCP_TELEGRAM_ALLOWED_CHAT_IDS: "123,-10042" }));
    assert.equal(registry(server)["telegram-list-chats"], undefined);
    assert.equal(registry(server)["telegram-search-chats"], undefined);
    for (const chatId of ["456", "@friend", "0123"]) {
      const res = await call(server, telegram, {
        type: "tool",
        id: chatId,
        tool: "telegram-read-messages",
        args: { chatId },
      });
      assert.match(String(res.error), /not allowed/);
    }
    assert.equal(connected, 0);
    const res = await call(server, telegram, {
      type: "tool",
      id: "ok",
      tool: "telegram-read-messages",
      args: { chatId: "123" },
    });
    assert.match(String(res.error), /Cannot verify/);
    assert.equal(connected, 1);
  });

  it("fails closed if the first connection attempt fails, without letting the handler reconnect", async () => {
    let connections = 0;
    let verified = false;
    let read = false;
    const telegram = {
      ensureConnected: async () => ++connections > 1,
      requireExactChatId: async () => {
        verified = true;
      },
      readMessages: async () => {
        read = true;
        return [];
      },
    } as unknown as TelegramService;
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, telegram, readToolPolicy({ MCP_TELEGRAM_ALLOWED_CHAT_IDS: "123" }));
    const res = await call(server, telegram, {
      type: "tool",
      id: "reconnect",
      tool: "telegram-read-messages",
      args: { chatId: "123" },
    });
    assert.match(String(res.error), /Cannot verify/);
    assert.equal(connections, 1);
    assert.equal(verified, false);
    assert.equal(read, false);
  });

  it("rejects numeric title and canonical peer substitution through the actual owner registry", async () => {
    for (const direct of [false, true]) {
      const telegram = new TelegramService(1, "test", { sessionPath: "/nonexistent/security-test-session" });
      const other = new Api.User({ id: bigInt(999), firstName: "Not allowed" });
      Object.assign(telegram, {
        ensureConnected: async () => true,
        client: {
          getEntity: async () => {
            if (direct) return other;
            throw new Error("Not found");
          },
          getDialogs: async () => [{ entity: other, title: "123" }],
        },
      });
      const server = new McpServer({ name: "test", version: "1" });
      registerTools(server, telegram, readToolPolicy({ MCP_TELEGRAM_ALLOWED_CHAT_IDS: "123" }));
      const res = await call(server, telegram, {
        type: "tool",
        id: "substitution",
        tool: "telegram-get-chat-info",
        args: { chatId: "123" },
      });
      assert.match(String(res.error), /Cannot find chat|canonical chat ID/);
      assert.ok(!JSON.stringify(res).includes("Not allowed"));
    }
  });

  it("refuses upload URLs before calling GramJS in explicit full mode", async () => {
    let sent = false;
    const telegram = {
      ensureConnected: async () => true,
      credentialFiles: [],
      sendFile: async () => {
        sent = true;
      },
    } as unknown as TelegramService;
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, telegram, { mode: "full" });
    const res = await call(server, telegram, {
      type: "tool",
      id: "url",
      tool: "telegram-send-file",
      args: { chatId: "123", filePath: "http://127.0.0.1/private" },
    });
    assert.equal(sent, false);
    assert.equal((res.result as { isError: boolean }).isError, true);
  });

  it("requires explicit full mode to restore write tools, with honest local-write annotations", () => {
    const server = new McpServer({ name: "test", version: "1" });
    registerTools(server, noTelegram, readToolPolicy({ MCP_TELEGRAM_MODE: "full" }));
    assert.ok(registry(server)["telegram-send-file"]);
    const tools = registry(server) as unknown as Record<string, { annotations: { readOnlyHint: boolean } }>;
    assert.equal(tools["telegram-download-media"].annotations.readOnlyHint, false);
    assert.equal(tools["telegram-get-profile-photo"].annotations.readOnlyHint, false);
  });

  it("validates IPC tool schemas, including defaults and transforms, without echoing rejected values", async () => {
    let called = 0;
    const server = new McpServer({ name: "test", version: "1" });
    server.registerTool(
      "echo",
      { inputSchema: { count: z.number().default(7), text: z.string().transform((x) => x.toUpperCase()) } },
      async (args) => {
        called++;
        return { content: [{ type: "text", text: JSON.stringify(args) }] };
      },
    );
    const bad = await call(server, noTelegram, {
      type: "tool",
      id: "bad",
      tool: "echo",
      args: { count: "secret-code", text: "x" },
    });
    assert.equal(called, 0);
    assert.match(String(bad.error), /Invalid arguments/);
    assert.ok(!JSON.stringify(bad).includes("secret-code"));
    const good = await call(server, noTelegram, { type: "tool", id: "ok", tool: "echo", args: { text: "hello" } });
    assert.equal(called, 1);
    assert.ok(JSON.stringify(good.result).includes('\\"count\\":7'));
    assert.ok(JSON.stringify(good.result).includes("HELLO"));
  });

  it("does not expose prototype properties or disabled tools through IPC", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const tool = server.registerTool("disabled", {}, async () => {
      throw new Error("must not run");
    });
    tool.disable();
    for (const name of ["disabled", "__proto__", "constructor"]) {
      const res = await call(server, noTelegram, { type: "tool", id: name, tool: name, args: {} });
      assert.match(String(res.error), /Unknown tool/);
    }
  });

  it("refuses IPC login by default without starting authentication", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const res = await call(server, noTelegram, { type: "login_start", id: "login" });
    assert.equal(res.success, false);
    assert.match(String(res.error), /disabled in read-only/);
  });

  it("rejects malformed tool envelopes instead of passing arrays or null to handlers", () => {
    for (const request of [
      { type: "tool", id: "x", tool: 42, args: {} },
      { type: "tool", id: "x", tool: "echo", args: [] },
      { type: "tool", id: "x", tool: "echo", args: null },
    ])
      assert.deepEqual(parseMessages(`${JSON.stringify(request)}\n`).messages, []);
  });
});
