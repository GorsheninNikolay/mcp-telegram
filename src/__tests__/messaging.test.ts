import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { after, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IpcClient } from "../client.js";
import { encodeMessage, ipcIdentity, type McpServerInternal } from "../ipc-protocol.js";
import { handleClient } from "../master.js";
import { TelegramService } from "../telegram-client.js";
import { readToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";
import { cleanupIpcEndpoint, makeIpcEndpoint } from "./ipc-endpoint.helper.js";

const endpoints: string[] = [];
after(() => {
  for (const path of endpoints) cleanupIpcEndpoint(path);
});
it("messaging exposes exactly the reviewed text tools and three transfer tools", () => {
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, {} as TelegramService, readToolPolicy({ MCP_TELEGRAM_MODE: "messaging" }));
  const names = Object.keys((server as unknown as McpServerInternal)._registeredTools);
  assert.equal(names.length, 12);
  for (const name of ["telegram-send-message", "telegram-send-file", "telegram-download-media"])
    assert.ok(names.includes(name));
  for (const name of ["telegram-login", "telegram-logout", "telegram-delete-messages", "telegram-join-chat"])
    assert.ok(!names.includes(name));
});
it("does not retry a new send after a network timeout; uploads >20 MiB from memory", async () => {
  const service = new TelegramService(1, "test");
  let sends = 0;
  const fake = {
    sendMessage: async () => {
      sends++;
      throw new Error("TIMEOUT");
    },
    uploadFile: async (params: { maxBufferSize: number; file: { buffer: Buffer; path: string } }) => {
      assert.equal(params.maxBufferSize, 50 * 1024 * 1024);
      assert.equal(params.file.buffer.length, 21 * 1024 * 1024);
      assert.equal(params.file.path, "");
      return "uploaded-handle";
    },
    sendFile: async (peer: unknown, params: { file: unknown }) => {
      assert.equal(peer, "peer");
      assert.equal(params.file, "uploaded-handle");
    },
  };
  Object.assign(service, { client: fake, connected: true, resolvePeer: async () => "peer" });
  await assert.rejects(service.sendMessage("1", "text"), /TIMEOUT/);
  assert.equal(sends, 1);
  await service.sendFileSnapshot("1", { name: "large.bin", bytes: Buffer.alloc(21 * 1024 * 1024) });
});
it("refuses an old server without handshake and never sends a tool to it", async () => {
  class OldSocket extends EventEmitter {
    writes: string[] = [];
    write(line: string) {
      this.writes.push(line);
      return true;
    }
    destroy() {
      this.emit("close");
    }
  }
  const old = new OldSocket();
  const client = new IpcClient({ connectFn: () => old as unknown as Socket, connectTimeoutMs: 20 });
  setImmediate(() => old.emit("connect"));
  assert.equal(await client.connect(), false);
  assert.equal(old.writes.length, 1);
  assert.equal(JSON.parse(old.writes[0]).type, "hello");
  await assert.rejects(client.call("telegram-send-message", {}), /not connected/);
  client.destroy();
});
it("serves two clients, rejects identity mismatches and never replays a timed-out send", async () => {
  const path = makeIpcEndpoint("messaging");
  endpoints.push(path);
  let sends = 0;
  const registry = {
    _registeredTools: {
      status: { handler: async () => ({ connected: true }) },
      "telegram-send-message": {
        handler: async () => {
          sends++;
          await new Promise((resolve) => setTimeout(resolve, 80));
          return "sent";
        },
      },
    },
  } as McpServerInternal;
  const server = createServer((socket) =>
    handleClient(socket, registry, {} as TelegramService, { toolCallTimeoutMs: 30 }),
  );
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const clients = [
    new IpcClient({ connectFn: () => connect(path), callTimeoutMs: 200 }),
    new IpcClient({ connectFn: () => connect(path), callTimeoutMs: 200 }),
  ];
  try {
    assert.deepEqual(await Promise.all(clients.map((client) => client.connect())), [true, true]);
    assert.deepEqual(await Promise.all(clients.map((client) => client.call("status", {}))), [
      { connected: true },
      { connected: true },
    ]);
    await assert.rejects(clients[0].call("telegram-send-message", {}), /unknown; do not retry/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sends, 1);
    const mismatch = connect(path);
    await new Promise<void>((resolve) => {
      mismatch.on("connect", () =>
        mismatch.write(encodeMessage({ type: "hello", id: "bad", identity: `${ipcIdentity()}-different-policy` })),
      );
      mismatch.on("close", resolve);
    });
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
