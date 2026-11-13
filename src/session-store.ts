import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface SessionStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  delete(): Promise<void>;
}

const helper = fileURLToPath(new URL("../native/keychain-helper", import.meta.url));
export async function keychain(
  operation: "load" | "save" | "delete",
  account: string,
  value?: string,
  interactive = false,
): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required; plaintext fallback is disabled");
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    let output = "";
    let failed = false;
    const fail = () => {
      failed = true;
      reject(new Error("Keychain operation failed; plaintext fallback is disabled"));
    };
    child.on("error", fail);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 65536) {
        child.kill();
        fail();
      }
    });
    child.stderr.resume();
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) return fail();
      try {
        const result = JSON.parse(output) as { value: string | null };
        if (result.value !== null && typeof result.value !== "string") return fail();
        resolve(result.value);
      } catch {
        fail();
      }
    });
    child.stdin.on("error", fail);
    child.stdin.end(JSON.stringify({ operation, account, value, interactive }));
  });
}

export class KeychainSessionStore implements SessionStore {
  private readonly account: string;
  constructor(
    namespace: string,
    private readonly interactive = false,
  ) {
    this.account = `session-${createHash("sha256").update(namespace).digest("hex")}`;
  }
  load() {
    return keychain("load", this.account, undefined, this.interactive);
  }
  async save(value: string) {
    await keychain("save", this.account, value, this.interactive);
  }
  async delete() {
    await keychain("delete", this.account, undefined, this.interactive);
  }
}

export async function loadApiCredentials(interactive = false): Promise<{ apiId: number; apiHash: string }> {
  const raw = await keychain("load", "api-credentials", undefined, interactive);
  if (!raw) throw new Error("API credentials are missing from Keychain; run the local login CLI");
  try {
    const data = JSON.parse(raw) as { apiId: number; apiHash: string };
    if (!Number.isSafeInteger(data.apiId) || data.apiId <= 0 || !/^[a-f0-9]{32}$/i.test(data.apiHash))
      throw new Error();
    return data;
  } catch {
    throw new Error("Invalid API credentials in Keychain");
  }
}
