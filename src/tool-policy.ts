import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerInternal } from "./ipc-protocol.js";

// Do not infer this list from readOnlyHint: some upstream read tools write local files,
// consume paid allowances, or contact third parties.
const TEXT_READ_TOOLS = new Set([
  "telegram-status",
  "telegram-list-chats",
  "telegram-search-chats",
  "telegram-get-chat-info",
  "telegram-read-messages",
  "telegram-search-messages",
  "telegram-get-replies",
  "telegram-get-message-link",
  "telegram-get-message-buttons",
]);
const SCOPED_TOOLS = new Set([
  "telegram-status",
  "telegram-get-chat-info",
  "telegram-read-messages",
  "telegram-search-messages",
  "telegram-get-replies",
  "telegram-get-message-link",
  "telegram-get-message-buttons",
]);

export interface ToolPolicy {
  mode: "read-only" | "messaging" | "full";
  chatIds?: ReadonlySet<string>;
}

export function readToolPolicy(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  const mode = env.MCP_TELEGRAM_MODE ?? "read-only";
  if (mode !== "read-only" && mode !== "messaging" && mode !== "full") {
    throw new Error("MCP_TELEGRAM_MODE must be read-only, messaging or full");
  }
  const raw = env.MCP_TELEGRAM_ALLOWED_CHAT_IDS;
  if (raw === undefined) return { mode };
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.some((id) => !/^-?[1-9]\d*$/.test(id))) {
    throw new Error("MCP_TELEGRAM_ALLOWED_CHAT_IDS must contain numeric chat IDs, separated by commas");
  }
  if (mode !== "read-only") throw new Error("Chat scoping is supported only in read-only mode");
  return { mode, chatIds: new Set(ids) };
}

/** Applied to the owner's registry as well as client catalogs, including raw IPC calls. */
export function applyToolPolicy(
  server: McpServer,
  policy: ToolPolicy,
  verifyChat?: (chatId: string) => Promise<void>,
): void {
  if (policy.mode === "full") return;
  const registry = (server as unknown as McpServerInternal)._registeredTools;
  const allowed =
    policy.mode === "messaging"
      ? new Set([...TEXT_READ_TOOLS, "telegram-send-message", "telegram-send-file", "telegram-download-media"])
      : policy.chatIds
        ? SCOPED_TOOLS
        : TEXT_READ_TOOLS;
  for (const [name, tool] of Object.entries(registry)) {
    if (!allowed.has(name)) {
      // Use the SDK lifecycle to remove the tool from both discovery and dispatch.
      if (!tool.remove) throw new Error("Incompatible MCP SDK: registered tool has no remove method");
      tool.remove();
      continue;
    }
    if (policy.chatIds && name !== "telegram-status") {
      const handler = tool.handler;
      tool.handler = async (args, extra) => {
        if (typeof args.chatId !== "string" || !policy.chatIds?.has(args.chatId)) {
          throw new Error("Chat is not allowed: use an explicitly permitted numeric chat ID");
        }
        await verifyChat?.(args.chatId);
        return handler(args, extra);
      };
    }
  }
}
