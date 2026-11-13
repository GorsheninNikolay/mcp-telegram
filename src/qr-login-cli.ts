#!/usr/bin/env node
import QRCode from "qrcode";
import { hiddenPrompt, localCredentials } from "./local-login.js";
import { releaseLock, tryAcquireLock } from "./lock.js";
import { TelegramService } from "./telegram-client.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Login requires a local interactive terminal");
  if (!(await tryAcquireLock())) throw new Error("Stop the running daemon before local login");
  process.once("exit", releaseLock);
  const { apiId, apiHash } = await localCredentials();
  const telegram = new TelegramService(apiId, apiHash, {
    interactiveKeychain: true,
    passwordPrompt: () => hiddenPrompt("Telegram 2FA password (hidden): "),
  });
  try {
    await telegram.loadSession();
    if (!(await telegram.connect())) {
      const result = await telegram.startQrLogin(
        () => {},
        async (url) => {
          console.clear();
          console.log(await QRCode.toString(url, { type: "terminal", small: true }));
          console.log("Scan in Telegram: Settings > Devices > Link Desktop Device");
        },
      );
      if (!result.success) throw new Error("Login failed; session was not accepted");
    }
    const firstAccount = await telegram.getMe();
    await telegram.disconnect();
    // A successful login includes reloading the persisted session and verifying it.
    if (!(await telegram.loadSession()) || !(await telegram.connect()))
      throw new Error("Saved session could not be reloaded");
    const reloadedAccount = await telegram.getMe();
    if (firstAccount.id !== reloadedAccount.id) throw new Error("Reloaded session account does not match");
    console.clear();
    console.log("Login verified; session saved in Keychain and reloaded successfully.");
    console.log(`Account: @${reloadedAccount.username ?? "unknown"} (id: ${reloadedAccount.id})`);
  } finally {
    await telegram.disconnect();
    releaseLock();
  }
}
main().catch(() => {
  console.error("Local login failed. No plaintext fallback was used.");
  process.exitCode = 1;
});
