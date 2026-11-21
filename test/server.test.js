import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("discover and call get_revit_session over stdio", async (t) => {
  const client = new Client({ name: "drive-it-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server/index.js", import.meta.url))],
  }));
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ["get_revit_session"]);
  const call = () => client.callTool({
    name: "get_revit_session", arguments: { processId: process.pid },
  });
  const disconnected = await call();
  assert.equal(disconnected.isError, true);
  assert.match(disconnected.content[0].text, /Revit/);

  if (process.platform === "win32") {
    const info = { processId: process.pid, version: "2026", build: "test" };
    const bridge = createServer(socket => socket.end(JSON.stringify(info) + "\n"));
    bridge.listen(String.raw`\\.\pipe\drive-it-${process.pid}`);
    await once(bridge, "listening");
    t.after(() => new Promise(resolve => bridge.close(resolve)));

    const result = await call();
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(result.structuredContent, info);
  }
});
