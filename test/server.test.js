import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer } from "../server/app.js";
import { apiReference } from "../server/reference.js";
import { Runtime } from "../server/runtime.js";
import { WorkspaceStore } from "../server/workspace.js";

async function clientFor(t, dataDir) {
  const client = new Client({ name: "drive-it-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server/index.js", import.meta.url))],
    env: { ...process.env, DRIVE_IT_DATA_DIR: dataDir },
  }));
  t.after(() => client.close());
  return client;
}

test("discover the Unguided tools and schemas over stdio", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "drive-it-protocol-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const client = await clientFor(t, dataDir);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [
    "get_revit_session", "execute_script", "save_script", "search_scripts", "get_script",
    "promote_script", "retire_script", "capture_revit_view", "get_api_reference",
  ]);
  assert.ok(!tools.some(tool => tool.name === "get_guidance"));
  const execute = tools.find(tool => tool.name === "execute_script");
  assert.ok(execute.inputSchema.properties.source);
  assert.ok(execute.inputSchema.properties.script);
  assert.ok(execute.inputSchema.properties.idempotencyKey);
  assert.ok(execute.inputSchema.required.includes("displayName"));

  const unnamed = await client.callTool({ name: "execute_script", arguments: { processId: 123, source: "result = 1" } });
  assert.equal(unnamed.isError, true);
  assert.match(unnamed.content[0].text, /displayName/);

  const allReferences = await client.callTool({ name: "get_api_reference", arguments: {} });
  assert.deepEqual(allReferences.structuredContent.entries, apiReference());

  const reference = await client.callTool({ name: "get_api_reference", arguments: { name: "revit.create_level" } });
  assert.equal(reference.structuredContent.version, "revit-2026-alpha.4");
  assert.equal(reference.structuredContent.entries.length, 1);
  assert.equal(reference.structuredContent.entries[0].name, "revit.create_level");
  assert.ok(reference.structuredContent.entries[0].example.includes("revit.create_level"));

  const ambiguous = await client.callTool({
    name: "execute_script",
    arguments: { processId: 123, displayName: "Ambiguous run", source: "result = 1", script: { scriptId: "saved", revision: 1 } },
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /exactly one/);
});

test("get_revit_session reports disconnect and validates a Windows pipe", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "drive-it-session-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const client = await clientFor(t, dataDir);
  const processId = process.pid;
  const call = () => client.callTool({ name: "get_revit_session", arguments: { processId } });
  const disconnected = await call();
  assert.equal(disconnected.isError, true);
  assert.match(disconnected.content[0].text, /Revit/);

  if (process.platform === "win32") {
    const info = { processId, version: "2026", build: "test" };
    const bridge = createServer(socket => socket.end(`${JSON.stringify(info)}\n`));
    bridge.listen(String.raw`\\.\pipe\drive-it-${processId}`);
    await once(bridge, "listening");
    t.after(() => new Promise(resolve => bridge.close(resolve)));

    const expected = {
      ...info,
      connectionIdentity: `current-user:named-pipe:drive-it-${processId}`,
      workspaceRoot: null,
    };
    const result = await call();
    assert.ok(!result.isError, result.content[0].text);
    const { content, ...session } = result.structuredContent;
    assert.deepEqual(session, expected);
    assert.ok(Array.isArray(content.projectTemplates));

    // Without a processId, the real \\.\pipe listing finds this session. Other test files run
    // in parallel and may hold their own drive-it pipes, in which case the ambiguity error must
    // still name this one.
    const found = await client.callTool({ name: "get_revit_session", arguments: {} });
    if (found.isError) {
      assert.match(found.content[0].text, new RegExp(`Several Revit sessions.*processId ${processId}\\b`));
    } else {
      assert.equal(found.structuredContent.processId, processId);
    }
  }
});

test("execute_script receipts validate against the advertised output schema", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "drive-it-schema-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({
    dataDir: base,
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
  });
  await runtime.workspace.setRoot(base);
  const { server } = createDriveItServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-schema-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());

  // listTools caches the output schemas the SDK client then enforces on every call.
  await client.listTools();
  for (const source of ["result = {'answer': 42}", "raise ValueError('expected failure')"]) {
    const result = await client.callTool({ name: "execute_script", arguments: { processId: 123, displayName: "Check the receipt schema", source } });
    assert.ok(result.structuredContent.runId, result.content[0].text);
    assert.equal(result.structuredContent.displayName, "Check the receipt schema");
  }
});

test("execute_script uses the greeting and newline JSON broker contract", { skip: process.platform !== "win32" }, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "drive-it-data-"));
  const root = await mkdtemp(path.join(tmpdir(), "drive-it-root-"));
  t.after(() => Promise.all([
    rm(dataDir, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true }),
  ]));
  await new WorkspaceStore(dataDir).setRoot(root);
  const processId = 424242;
  const envelopes = [];
  const bridge = createServer(socket => {
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify({ processId, version: "2026", build: "test" })}\n`);
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      const envelope = JSON.parse(input.split("\n")[0]);
      envelopes.push(envelope);
      socket.end(`${JSON.stringify({
        id: envelope.id,
        status: "succeeded",
        document: { path: null, uniqueId: "document-handle", kind: "rvt" },
        changes: [{ type: "create_level", name: "L2" }],
        affectedFiles: [],
        affectedElements: [{ elementId: 100 }],
        checks: [{ name: "transaction committed", passed: true }],
      })}\n`);
    });
  });
  bridge.listen(String.raw`\\.\pipe\drive-it-${processId}`);
  await once(bridge, "listening");
  t.after(() => new Promise(resolve => bridge.close(resolve)));
  const client = await clientFor(t, dataDir);
  const result = await client.callTool({
    name: "execute_script",
    arguments: {
      processId,
      displayName: "Add level L2",
      source: "result = revit.create_level(name=\"L2\", elevation=4.0)",
      idempotencyKey: "windows-broker-contract",
    },
  });
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.structuredContent.status, "succeeded");
  assert.equal(result.structuredContent.document.uniqueId, "document-handle");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].type, "model.execute");
  assert.equal(envelopes[0].operations[0].type, "create_level");
  assert.equal(envelopes[0].outsideRootApproval, undefined);
});

test("the session tool finds the only Revit and tells the agent where to work", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "drive-it-find-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({ dataDir: base });
  await runtime.workspace.setRoot(base);
  const content = { projectTemplates: ["C:/T/default.rte"], familyTemplateFolders: ["C:/F"], libraryFolders: ["C:/L"] };
  const { server } = createDriveItServer({
    runtime,
    processResolver: async processId => processId ?? 4321,
    sessionReader: async processId => ({ processId, version: "2026", build: "b", connectionIdentity: `pipe-${processId}` }),
    contentReader: async () => content,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-find-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  await client.listTools();

  const result = await client.callTool({ name: "get_revit_session", arguments: {} });
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.structuredContent.processId, 4321);
  assert.equal(result.structuredContent.workspaceRoot, await runtime.workspace.getRoot());
  assert.deepEqual(result.structuredContent.content, content);

  const fresh = new Runtime({ dataDir: path.join(base, "fresh") });
  const { server: freshServer } = createDriveItServer({
    runtime: fresh,
    processResolver: async processId => processId ?? 4321,
    sessionReader: async processId => ({ processId, version: "2026", build: "b", connectionIdentity: `pipe-${processId}` }),
    contentReader: async () => content,
  });
  const [freshClientTransport, freshServerTransport] = InMemoryTransport.createLinkedPair();
  await freshServer.connect(freshServerTransport);
  const freshClient = new Client({ name: "drive-it-fresh-test", version: "1" });
  await freshClient.connect(freshClientTransport);
  t.after(() => freshClient.close());
  await freshClient.listTools();
  const unset = await freshClient.callTool({ name: "get_revit_session", arguments: {} });
  assert.ok(!unset.isError, unset.content[0].text);
  assert.equal(unset.structuredContent.workspaceRoot, null);
});

test("a pending run tells the agent to resume with the same idempotency key", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "drive-it-resume-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
  });
  await mkdir(root);
  await runtime.workspace.setRoot(root);
  const { server } = createDriveItServer({ runtime, processResolver: async processId => processId ?? 123 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-resume-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  await client.listTools();

  const result = await client.callTool({ name: "execute_script", arguments: {
    displayName: "Write a note outside the workspace",
    source: "files.write(args['path'], 'x')",
    arguments: { path: path.join(base, "outside.txt") },
    idempotencyKey: "resume-me",
  } });
  assert.equal(result.structuredContent.status, "pending");
  assert.equal(result.structuredContent.session.processId, 123);
  assert.match(result.content[0].text, /^WAITING FOR THE USER/);
  assert.match(result.content[0].text, /idempotencyKey "resume-me"/);
});
