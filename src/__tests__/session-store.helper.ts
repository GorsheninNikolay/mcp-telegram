import { readFile, unlink, writeFile } from "node:fs/promises";
import type { SessionStore } from "../session-store.js";

// Test-only filesystem adapter. Production has no plaintext adapter or fallback.
export function testSessionStore(path: string): SessionStore {
  return {
    load: async () =>
      readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    save: async (value) => {
      await writeFile(path, value);
    },
    delete: async () => {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
