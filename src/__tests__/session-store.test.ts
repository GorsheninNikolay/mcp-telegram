import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { SessionStore } from "../session-store.js";
import { TelegramService } from "../telegram-client.js";

it("storage denial never imports a plaintext session or masks save/delete failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-denied-"));
  const path = join(dir, "session");
  await writeFile(path, "A".repeat(200));
  try {
    for (const reason of ["locked", "access denied", "save failed"]) {
      const store: SessionStore = {
        load: async () => {
          throw new Error(reason);
        },
        save: async () => {
          throw new Error(reason);
        },
        delete: async () => {
          throw new Error(reason);
        },
      };
      const service = new TelegramService(1, "test", { sessionPath: path, sessionStore: store });
      await assert.rejects(service.loadSession(), new RegExp(reason));
      assert.equal(service.getSessionString(), "");
      const persist = service as unknown as { saveSession(value: string): Promise<void> };
      await assert.rejects(persist.saveSession("B".repeat(200)), new RegExp(reason));
      assert.equal(service.getSessionString(), "");
      await assert.rejects(service.logOut(), new RegExp(reason));
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
it("persists before adopting a session and supports a fresh service loading it", async () => {
  let saved: string | null = null;
  const store: SessionStore = {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
    delete: async () => {
      saved = null;
    },
  };
  const first = new TelegramService(1, "test", { sessionStore: store });
  await (first as unknown as { saveSession(value: string): Promise<void> }).saveSession("A".repeat(200));
  const second = new TelegramService(1, "test", { sessionStore: store });
  assert.equal(await second.loadSession(), true);
  assert.equal(second.getSessionString(), saved);
  await second.logOut();
  assert.equal(saved, null);
});
