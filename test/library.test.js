import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer } from "../server/app.js";
import { Runtime } from "../server/runtime.js";

const LEVEL_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, elevation: { type: "number", default: 3 } },
  required: ["name"],
  additionalProperties: false,
};
const LEVEL_SOURCE = "result = {'name': args['name'], 'elevation': args['elevation']}\nchecks.record('named', bool(args['name']), args['name'])";

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-library-")));
  const root = path.join(base, "workspace");
  const other = path.join(base, "other");
  const dataDir = path.join(base, "data");
  await mkdir(root);
  await mkdir(other);
  t.after(() => rm(base, { recursive: true, force: true }));
  const make = () => new Runtime({
    dataDir,
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
  });
  const runtime = make();
  await runtime.workspace.setRoot(root);
  return { base, root, other, dataDir, runtime, make };
}

function saveLevel(runtime, overrides = {}) {
  return runtime.scripts.save({
    name: "Create level",
    purpose: "Create one named level",
    domain: "levels",
    documentKind: "rvt",
    inputSchema: LEVEL_SCHEMA,
    source: LEVEL_SOURCE,
    ...overrides,
  });
}

function run(runtime, root, script, overrides = {}) {
  return runtime.execute({
    processId: 123,
    script,
    arguments: { name: "L2" },
    document: { path: path.join(root, "model.rvt") },
    ...overrides,
  });
}

test("revisions are durable, immutable, searchable, and idempotent", async (t) => {
  const { root, runtime, make } = await fixture(t);
  const first = await saveLevel(runtime, { idempotencyKey: "save-1" });
  assert.equal(first.created, true);
  assert.equal(first.revision.scriptId, "create-level");
  assert.equal(first.revision.revision, 1);
  assert.equal(first.revision.state, "draft");
  assert.match(first.revision.codeHash, /^[a-f0-9]{64}$/);

  const retry = await saveLevel(runtime, { idempotencyKey: "save-1" });
  assert.equal(retry.created, false);
  assert.equal(retry.revision.revision, 1);
  await assert.rejects(saveLevel(runtime, { idempotencyKey: "save-1", source: "result = 2" }), { code: "IDEMPOTENCY_CONFLICT" });

  const second = await runtime.scripts.save({ scriptId: "create-level", source: `${LEVEL_SOURCE}\n# v2` });
  assert.equal(second.revision.revision, 2);
  assert.equal(second.revision.purpose, "Create one named level", "metadata carries forward");
  assert.deepEqual(second.revision.inputSchema, LEVEL_SCHEMA);
  assert.notEqual(second.revision.codeHash, first.revision.codeHash);

  // A fresh server process reads the same library.
  const restarted = make();
  const one = await restarted.scripts.get({ scriptId: "create-level", revision: 1 });
  assert.equal(one.source, LEVEL_SOURCE);
  assert.equal(one.codeHash, first.revision.codeHash);
  assert.deepEqual(one.runs, []);

  assert.deepEqual((await restarted.scripts.search({})).scripts, [], "drafts are hidden by default");
  const drafts = await restarted.scripts.search({ query: "level", includeDrafts: true });
  assert.deepEqual(drafts.scripts.map(row => row.revision), [2, 1]);
  assert.equal(drafts.workspaceRoot, root);
  assert.deepEqual((await restarted.scripts.search({ includeDrafts: true, documentKind: "rfa" })).scripts, []);
  assert.deepEqual((await restarted.scripts.search({ includeDrafts: true, query: "walls" })).scripts, []);
});

test("concurrent saves from separate servers receive distinct revisions", async (t) => {
  const { runtime, make } = await fixture(t);
  await saveLevel(runtime);
  const servers = Array.from({ length: 6 }, make);
  const saved = await Promise.all(servers.map((server, index) =>
    server.scripts.save({ scriptId: "create-level", source: `${LEVEL_SOURCE}\n# ${index}` })));
  const revisions = saved.map(row => row.revision.revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, [2, 3, 4, 5, 6, 7]);
  for (const row of saved) {
    const stored = await runtime.scripts.get({ scriptId: "create-level", revision: row.revision.revision });
    assert.equal(stored.source, row.revision.source);
  }
  const names = await readdir(path.join(await runtime.workspace.getRoot(), ".drive-it", "scripts", "create-level"));
  assert.ok(!names.some(name => name.endsWith(".tmp")), names.join(","));
});

test("saved revisions execute with validated arguments and latest resolves only active", async (t) => {
  const { root, runtime } = await fixture(t);
  await saveLevel(runtime);
  const receipt = await run(runtime, root, { scriptId: "create-level", revision: 1 });
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.deepEqual(receipt.result, { name: "L2", elevation: 3 }, "schema default applied");
  assert.deepEqual(receipt.arguments, { name: "L2", elevation: 3 });
  assert.equal(receipt.savedScript.scriptId, "create-level");
  assert.equal(receipt.savedScript.codeHash, receipt.codeHash);

  await assert.rejects(run(runtime, root, { scriptId: "create-level", revision: 1 }, { arguments: { name: 5 } }), { code: "INVALID_ARGUMENTS" });
  await assert.rejects(run(runtime, root, { scriptId: "create-level", revision: 9 }), { code: "SCRIPT_NOT_FOUND" });
  await assert.rejects(run(runtime, root, { scriptId: "missing", revision: 1 }), { code: "SCRIPT_NOT_FOUND" });
  await assert.rejects(run(runtime, root, { scriptId: "create-level", revision: "latest" }), { code: "NO_ACTIVE_REVISION" });

  assert.equal((await runtime.scripts.promote({ scriptId: "create-level", revision: 1, runId: receipt.runId })).status, "promoted");
  await runtime.scripts.save({ scriptId: "create-level", source: `${LEVEL_SOURCE}\n# draft 2` });
  const latest = await run(runtime, root, { scriptId: "create-level", revision: "latest" });
  assert.equal(latest.savedScript.revision, 1, "a newer draft is not latest");
  assert.equal(latest.savedScript.requested, "latest");
});

test("promotion requires a checked successful run of the exact revision", async (t) => {
  const { root, runtime } = await fixture(t);
  await saveLevel(runtime);
  await runtime.scripts.save({ scriptId: "create-level", source: "raise RuntimeError('boom')" });
  await runtime.scripts.save({ scriptId: "create-level", source: "result = 1" });
  await runtime.scripts.save({ scriptId: "create-level", source: "checks.record('bad', False)" });
  const promote = (revision, runId) => runtime.scripts.promote({ scriptId: "create-level", revision, runId });
  const conditions = result => result.unmet.map(row => row.condition);

  const failed = await run(runtime, root, { scriptId: "create-level", revision: 2 });
  assert.equal(failed.status, "failed");
  assert.deepEqual(conditions(await promote(2, failed.runId)), ["succeeded", "has_checks"]);

  const unchecked = await run(runtime, root, { scriptId: "create-level", revision: 3 });
  assert.deepEqual(conditions(await promote(3, unchecked.runId)), ["has_checks"]);

  const failingCheck = await run(runtime, root, { scriptId: "create-level", revision: 4 });
  assert.deepEqual(conditions(await promote(4, failingCheck.runId)), ["checks_passed"]);

  const good = await run(runtime, root, { scriptId: "create-level", revision: 1 });
  assert.deepEqual(conditions(await promote(3, good.runId)), ["same_revision", "same_code_hash"], "wrong hash");

  const family = await run(runtime, root, { scriptId: "create-level", revision: 1 }, { document: { path: path.join(root, "f.rfa") } });
  assert.deepEqual(conditions(await promote(1, family.runId)), ["document_kind"]);

  const inline = await runtime.execute({ processId: 123, source: LEVEL_SOURCE, arguments: { name: "L2", elevation: 3 }, document: { path: path.join(root, "m.rvt") } });
  assert.deepEqual(conditions(await promote(1, inline.runId)), ["same_script", "same_revision", "same_code_hash"]);
  assert.deepEqual(conditions(await promote(1, "no-such-run")), ["run_exists"]);

  for (const revision of [1, 2, 3, 4]) {
    assert.equal((await runtime.scripts.get({ scriptId: "create-level", revision })).state, "draft", "rejections leave drafts unchanged");
  }
  const promoted = await promote(1, good.runId);
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.script.state, "active");
  const detail = await runtime.scripts.get({ scriptId: "create-level", revision: 1 });
  assert.equal(detail.promotionRunId, good.runId);
  assert.equal(detail.promotionEvidence.codeHash, detail.codeHash);
  assert.ok(detail.runs.some(row => row.runId === good.runId && row.checked));
  assert.deepEqual(conditions(await promote(1, good.runId)), ["draft"], "already active");
  assert.deepEqual((await runtime.scripts.search({})).scripts.map(row => row.revision), [1]);
});

test("retirement preserves history and blocks reuse", async (t) => {
  const { root, runtime } = await fixture(t);
  await saveLevel(runtime);
  await runtime.scripts.save({ scriptId: "create-level", source: `${LEVEL_SOURCE}\n# 2` });
  const good = await run(runtime, root, { scriptId: "create-level", revision: 1 });
  await runtime.scripts.promote({ scriptId: "create-level", revision: 1, runId: good.runId });

  const active = await runtime.scripts.retire({ scriptId: "create-level", revision: 1, reason: "superseded" });
  assert.equal(active.script.state, "retired");
  const draft = await runtime.scripts.retire({ scriptId: "create-level", revision: 2 });
  assert.equal(draft.script.state, "retired");
  await assert.rejects(runtime.scripts.retire({ scriptId: "create-level", revision: 2 }), { code: "ALREADY_RETIRED" });

  assert.deepEqual((await runtime.scripts.search({ includeDrafts: true })).scripts, []);
  assert.deepEqual((await runtime.scripts.search({ includeRetired: true })).scripts.map(row => row.revision), [2, 1]);
  await assert.rejects(run(runtime, root, { scriptId: "create-level", revision: 1 }), { code: "SCRIPT_RETIRED" });
  await assert.rejects(run(runtime, root, { scriptId: "create-level", revision: "latest" }), { code: "NO_ACTIVE_REVISION" });

  const detail = await runtime.scripts.get({ scriptId: "create-level", revision: 1 });
  assert.equal(detail.source, LEVEL_SOURCE);
  assert.equal(detail.promotionRunId, good.runId, "promotion evidence survives retirement");
  assert.equal(detail.retirementReason, "superseded");
  assert.equal(detail.runs.length, 1);
  assert.ok(await runtime.history.get(good.runId));
  // Replaying the completed run returns its receipt even though the revision is retired.
  assert.deepEqual(await run(runtime, root, { scriptId: "create-level", revision: 1 }, { idempotencyKey: good.idempotencyKey }), good);
});

test("each root has its own library and cross-root receipts cannot promote", async (t) => {
  const { root, other, runtime } = await fixture(t);
  await saveLevel(runtime);
  const evidence = await run(runtime, root, { scriptId: "create-level", revision: 1 });
  assert.equal(evidence.status, "succeeded");

  await runtime.workspace.setRoot(other);
  await assert.rejects(runtime.scripts.search({}), { code: "LIBRARY_NOT_FOUND" });
  await saveLevel(runtime);
  const crossRoot = await runtime.scripts.promote({ scriptId: "create-level", revision: 1, runId: evidence.runId });
  assert.equal(crossRoot.status, "rejected");
  assert.deepEqual(crossRoot.unmet.map(row => row.condition), ["same_workspace"]);
  assert.equal((await runtime.scripts.get({ scriptId: "create-level", revision: 1 })).state, "draft");
  assert.ok(await runtime.history.get(evidence.runId), "old receipts stay inspectable");

  await runtime.workspace.setRoot(root);
  const original = await runtime.scripts.get({ scriptId: "create-level", revision: 1 });
  assert.equal(original.runs.length, 1, "the original root keeps its library and run links");
  assert.equal((await runtime.scripts.promote({ scriptId: "create-level", revision: 1, runId: evidence.runId })).status, "promoted");
});

test("missing, unreadable, and tampered libraries fail explicitly", async (t) => {
  const { root, runtime } = await fixture(t);
  await assert.rejects(runtime.scripts.search({}), { code: "LIBRARY_NOT_FOUND" });
  await assert.rejects(runtime.scripts.get({ scriptId: "create-level", revision: 1 }), { code: "LIBRARY_NOT_FOUND" });
  await saveLevel(runtime);
  const file = path.join(root, ".drive-it", "scripts", "create-level", "1.json");
  const row = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...row, source: "result = 'tampered'" }));
  await assert.rejects(runtime.scripts.get({ scriptId: "create-level", revision: 1 }), { code: "LIBRARY_UNREADABLE" });
  await assert.rejects(run(runtime, root, { scriptId: "create-level", revision: 1 }), { code: "LIBRARY_UNREADABLE" });
  await writeFile(file, "{");
  await assert.rejects(runtime.scripts.search({ includeDrafts: true }), { code: "LIBRARY_UNREADABLE" });
  await assert.rejects(runtime.scripts.save({ name: "x", documentKind: "rvt", inputSchema: { type: "array" }, source: "result = 1" }), { code: "INVALID_INPUT_SCHEMA" });
  await assert.rejects(runtime.scripts.save({ name: "x", source: "result = 1" }), { code: "INVALID_SCRIPT" });
});

test("library tools round-trip over MCP with schema-valid structured content", async (t) => {
  const { root, runtime } = await fixture(t);
  const { server } = createDriveItServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-library-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  await client.listTools();
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return result;
  };

  const empty = await call("search_scripts", {});
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /^LIBRARY_NOT_FOUND/);

  const saved = await call("save_script", {
    name: "Create level", purpose: "Create one named level", domain: "levels", documentKind: "rvt",
    inputSchema: LEVEL_SCHEMA, source: LEVEL_SOURCE, expectedEffects: ["one level"], capabilities: ["revit.create_level"],
  });
  assert.ok(!saved.isError, saved.content[0].text);
  const { scriptId, revision } = saved.structuredContent.script;

  const executed = await call("execute_script", {
    processId: 123, displayName: "Add level L3 to the test model", script: { scriptId, revision }, arguments: { name: "L3" },
    document: { path: path.join(root, "model.rvt") },
  });
  assert.ok(!executed.isError, executed.content[0].text);
  assert.equal(executed.structuredContent.savedScript.revision, revision);

  const bad = await call("execute_script", { processId: 123, displayName: "Add a level with a bad name", script: { scriptId, revision }, arguments: { name: 1 } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /^INVALID_ARGUMENTS/);

  const promoted = await call("promote_script", { scriptId, revision, runId: executed.structuredContent.runId });
  assert.ok(!promoted.isError, promoted.content[0].text);
  assert.equal(promoted.structuredContent.status, "promoted");
  const rejected = await call("promote_script", { scriptId, revision, runId: executed.structuredContent.runId });
  assert.equal(rejected.isError, true);
  assert.deepEqual(rejected.structuredContent.unmet.map(row => row.condition), ["draft"]);

  const found = await call("search_scripts", { query: "level" });
  assert.equal(found.structuredContent.scripts.length, 1);
  const detail = await call("get_script", { scriptId, revision: "latest" });
  assert.ok(!detail.isError, detail.content[0].text);
  assert.equal(detail.structuredContent.source, LEVEL_SOURCE);
  assert.equal(detail.structuredContent.runs.length, 1);

  const retired = await call("retire_script", { scriptId, revision });
  assert.equal(retired.structuredContent.script.state, "retired");
  const blocked = await call("execute_script", { processId: 123, displayName: "Run a retired script", script: { scriptId, revision } });
  assert.match(blocked.content[0].text, /^SCRIPT_RETIRED/);
});
