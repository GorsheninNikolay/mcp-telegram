import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("native tool registry and IPC entrypoints never load Hono HTTP dependencies", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/^(hono|@hono\\/node-server)(\\/|$)/.test(specifier)) throw new Error('Forbidden HTTP dependency loaded');
      return next(specifier, context);
    }});
    await import('./src/client.ts'); await import('./src/master.ts');
    await import('./src/serve.ts'); await import('./src/local-login.ts');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerTools } = await import('./src/tools/index.ts');
    registerTools(new McpServer({name:'test',version:'1'}), {}, {mode:'messaging'});
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
