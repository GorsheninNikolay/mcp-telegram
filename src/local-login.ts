import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { keychain, loadApiCredentials } from "./session-store.js";

export async function hiddenPrompt(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Local interactive terminal required");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          finish();
          reject(new Error("Login cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          resolve(text);
          return;
        }
        if (char === "\u007f") text = text.slice(0, -1);
        else if (char >= " ") text += char;
      }
    };
    stdin.on("data", onData);
  });
}

export async function localCredentials(): Promise<{ apiId: number; apiHash: string }> {
  // Access denied / locked Keychain must fail, never be treated as absent.
  const existing = await keychain("load", "api-credentials", undefined, true);
  if (existing !== null) return loadApiCredentials(true);
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Local interactive terminal required");
  const terminal = createInterface({ input: stdin, output: stdout });
  const apiId = Number(await terminal.question("Telegram API ID: "));
  terminal.close();
  const apiHash = await hiddenPrompt("Telegram API hash (hidden): ");
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash))
    throw new Error("Invalid API credentials");
  await keychain("save", "api-credentials", JSON.stringify({ apiId, apiHash }), true);
  return loadApiCredentials(true);
}
