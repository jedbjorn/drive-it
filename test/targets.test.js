// Spec #28 "Drive-It document targets", the server's half: execute_script's targets (and document, its one-target
// form) are checked and resolved before a line of the script runs, carried to the worker, the hold and every built-in
// batch, kept in the fingerprint only when given, and returned on the receipt; get_revit_session lists the open
// documents with a bounded read. The add-in's refusal (document_not_targeted) is proven live on W10C.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer, serverInstructions } from "../server/app.js";
import { apiReference, ACTIVE_DOCUMENT_NOTE, DOCUMENT_DESCRIPTION, DOCUMENTS_GUIDANCE, MODEL_GUIDANCE_LIMITS, OPEN_DOCUMENTS_DESCRIPTION, TARGETS_DESCRIPTION, TARGETS_REFERENCE } from "../server/reference.js";
import { callOf, Runtime } from "../server/runtime.js";
import { readDocuments, readOpenDocuments } from "../server/session.js";

const OPEN = [
  { uniqueId: "a-1", title: "Tower.rvt", path: "C:\\Models\\Tower.rvt", kind: "rvt", isActive: true },
  { uniqueId: "b-2", title: "Annex.rvt", path: "C:\\Models\\Annex.rvt", kind: "rvt", isActive: false },
  { uniqueId: "c-3", title: "Site.rvt", path: null, kind: "rvt", isActive: false },
];
const targetOf = ({ isActive, ...target }) => target;

// The add-in's documents.list, as DocumentDispatcher.ListDocuments answers it: ids it does not know are stale.
function addIn({ busy = false } = {}) {
  const requests = [];
  const reader = async (processId, request) => {
    requests.push(request);
    if (busy) return { status: "busy" };
    const named = request.targets ?? (request.document?.uniqueId ? [request.document.uniqueId] : []);
    const unknown = named.find(id => !OPEN.some(row => row.uniqueId === id));
    if (unknown) {
      return { status: "failed", error: { code: "stale_document_identity", message: `Target ${unknown}: The selected document identity is no longer open in this Revit session. Open documents: 'Tower.rvt' uniqueId a-1 (in Revit's window), 'Annex.rvt' uniqueId b-2, 'Site.rvt' uniqueId c-3.` } };
    }
    return { status: "succeeded", openDocuments: OPEN, targets: named.map(id => targetOf(OPEN.find(row => row.uniqueId === id))) };
  };
  return { requests, reader };
}

// Revit's side of a run: every built-in batch and every hold, recorded.
function stubRevit() {
  const batches = [];
  const holds = [];
  return {
    batches,
    holds,
    brokerExecutor: async (processId, envelope) => {
      batches.push(envelope);
      return { id: envelope.id, status: "succeeded", changes: ["Created level 'L3' (100)."], affectedFiles: [], affectedElements: [100], checks: [], results: envelope.operations.map(() => null) };
    },
    holdOpener: async (processId, options) => {
      const hold = {
        options,
        sent: [],
        onLost() {},
        send: async message => {
          hold.sent.push(message);
          if (message.type === "model.execute") return { id: message.id, status: "succeeded", changes: [], affectedFiles: [], affectedElements: [], checks: [], results: message.operations.map(() => null) };
          if (message.call.op === "tx.start") return { status: "succeeded", value: 1 };
          if (message.call.op === "tx.commit") return { status: "succeeded", value: { name: "Add level", document: "Annex.rvt", documentKey: "d1", added: [101], changed: [], deleted: [], totals: { added: 1, changed: 0, deleted: 0 }, truncated: false } };
          return { status: "succeeded", value: { $h: 1, type: "Autodesk.Revit.DB.Document" } };
        },
        end: async outcome => ({ outcome: outcome === "commit" ? "committed" : "rolled_back", ms: 1, calls: hold.sent.length, warnings: [], documents: [{ title: "Annex.rvt", path: "C:\\Models\\Annex.rvt", state: outcome === "commit" ? "committed" : "rolled_back" }] }),
      };
      holds.push(hold);
      return hold;
    },
  };
}

async function fixture(t, { busy = false, mode } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-targets-")));
  const root = path.join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const revit = stubRevit();
  const documents = addIn({ busy });
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    documentReader: documents.reader,
    brokerExecutor: revit.brokerExecutor,
    holdOpener: revit.holdOpener,
    ...(mode ? { modeResolver: async () => mode } : {}),
  });
  await runtime.workspace.setRoot(root);
  return { root, runtime, revit, documents };
}

let keys = 0;
const run = (runtime, overrides) => runtime.execute({ processId: 123, displayName: "Targets test", source: "result = 1", idempotencyKey: `targets-${++keys}`, ...overrides });

async function exists(file) {
  return access(file).then(() => true, () => false);
}

for (const mode of ["standard", "dev"]) {
  test(`targets resolve before the script, in order, and reach the worker, the hold and every batch (${mode})`, async (t) => {
    const { runtime, revit, documents } = await fixture(t, { mode });
    const receipt = await run(runtime, {
      targets: ["b-2", "c-3"],
      source: `
result = [target["title"] for target in revit.targets]
revit.create_level(name="L3", elevation=24)
for target in revit.targets:
    with revit.transaction("Add level", document=target):
        pass`,
    });
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
    assert.deepEqual(receipt.targets, [targetOf(OPEN[1]), targetOf(OPEN[2])]);
    assert.deepEqual(receipt.result, ["Annex.rvt", "Site.rvt"]);
    assert.deepEqual(documents.requests[0].targets, ["b-2", "c-3"]);
    // The first target is the script's current document: the built-in call named none and reached it.
    const batch = revit.batches[0] ?? revit.holds[0].sent.find(message => message.type === "model.execute");
    assert.equal(batch.document.uniqueId, "b-2");
    assert.deepEqual(batch.targets, ["b-2", "c-3"]);
    assert.deepEqual(revit.holds[0].options.targets, ["b-2", "c-3"]);
    const started = revit.holds[0].sent.filter(message => message.call?.op === "tx.start").map(message => message.call.document.uniqueId);
    assert.deepEqual(started, ["b-2", "c-3"]);
    assert.equal(receipt.document.uniqueId, "b-2");
  });
}

test("a call with no targets names none: the add-in is sent an empty list and nothing is resolved", async (t) => {
  const { runtime, revit, documents } = await fixture(t);
  const receipt = await run(runtime, { source: "revit.create_level(name='L3', elevation=24)" });
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.deepEqual(receipt.targets, []);
  assert.equal(documents.requests.length, 0);
  assert.deepEqual(revit.batches[0].targets, []);
});

test("document is the one-target form; a path no open document has names none", async (t) => {
  const { runtime, revit, documents } = await fixture(t);
  const byId = await run(runtime, { document: { uniqueId: "a-1" }, source: "result = revit.targets" });
  assert.equal(byId.status, "succeeded", JSON.stringify(byId.error));
  assert.deepEqual(byId.targets, [targetOf(OPEN[0])]);
  assert.deepEqual(byId.result, [targetOf(OPEN[0])]);
  assert.deepEqual(documents.requests[0].document, { path: null, uniqueId: "a-1" });

  const byPath = await run(runtime, { document: { path: path.join(tmpdir(), "closed.rvt") }, source: "revit.create_level(name='L3', elevation=24)" });
  assert.equal(byPath.status, "succeeded", JSON.stringify(byPath.error));
  assert.deepEqual(byPath.targets, []);
  assert.deepEqual(revit.batches.at(-1).targets, []);
});

test("targets and document together, a duplicate id, or an empty list are invalid_arguments before anything runs", async (t) => {
  const { runtime, documents } = await fixture(t);
  await assert.rejects(run(runtime, { targets: ["a-1"], document: { uniqueId: "a-1" } }), error => error.code === "invalid_arguments" && /targets or document/.test(error.message));
  await assert.rejects(run(runtime, { targets: ["a-1", "b-2", "a-1"] }), error => error.code === "invalid_arguments" && /a-1 twice/.test(error.message));
  await assert.rejects(run(runtime, { targets: [] }), error => error.code === "invalid_arguments");
  await assert.rejects(run(runtime, { targets: Array.from({ length: 51 }, (_, index) => `d-${index}`) }), error => error.code === "invalid_arguments");
  assert.equal(documents.requests.length, 0);
});

test("AC-7: a target that is not open fails stale_document_identity before the script's first line, naming it and the open documents", async (t) => {
  const { root, runtime, revit } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const file = path.join(root, "first-line.txt");
  const receipt = await run(runtime, { targets: ["b-2", "gone-9"], source: `files.write(${JSON.stringify(file)}, "x")` });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "stale_document_identity");
  assert.match(receipt.error.message, /gone-9/);
  assert.match(receipt.error.message, /'Tower\.rvt' uniqueId a-1 \(in Revit's window\), 'Annex\.rvt' uniqueId b-2/);
  assert.deepEqual(receipt.targets, []);
  assert.equal(await exists(file), false, "no line of the script ran");
  assert.equal(revit.batches.length + revit.holds.length, 0);
  assert.equal(receipt.rehearsedBy, null, "no rehearsal was taken by a run that never started");
});

test("a Revit that never frees its thread ends the run timed out before the script, without writing", async (t) => {
  const { root, runtime } = await fixture(t, { busy: true });
  const file = path.join(root, "first-line.txt");
  const receipt = await run(runtime, { targets: ["a-1"], source: `files.write(${JSON.stringify(file)}, "x")` });
  assert.equal(receipt.status, "timed_out");
  assert.equal(receipt.error.code, "RUN_TIMEOUT");
  assert.match(receipt.error.message, /no line of the script ran/);
  assert.equal(await exists(file), false);
});

test("AC-8 (server): targets join the fingerprint only when given; a dry run and its real run name the same targets", async (t) => {
  const { runtime } = await fixture(t);
  const plain = await run(runtime, {});
  assert.deepEqual(Object.keys(JSON.parse(plain.fingerprint)), ["codeHash", "script", "arguments", "processId", "document"], "a call without targets keeps its fingerprint");
  const targeted = await run(runtime, { targets: ["b-2"] });
  assert.deepEqual(JSON.parse(targeted.fingerprint).targets, ["b-2"]);

  await runtime.settings.setRequireDryRun("on");
  const source = "revit.create_level(name='L3', elevation=24)";
  const dry = await run(runtime, { source, targets: ["b-2"], dryRun: true });
  assert.equal(dry.status, "succeeded", JSON.stringify(dry.error));
  const real = await run(runtime, { source, targets: ["b-2"] });
  assert.equal(callOf(dry.fingerprint), real.fingerprint);
  assert.equal(real.rehearsedBy, dry.runId);
  const elsewhere = await run(runtime, { source, targets: ["c-3"] });
  assert.equal(elsewhere.rehearsedBy, null, "a dry run of B rehearses no run of C");
});

// A pipe-like listener: the add-in's handshake line, then whatever each test makes of the documents.list request.
async function documentsListener(t, answer) {
  const address = process.platform === "win32"
    ? String.raw`\\.\pipe\drive-it-targets-test-${process.pid}-${Math.random().toString(16).slice(2)}`
    : path.join(await mkdtemp(path.join(tmpdir(), "drive-it-pipe-")), "pipe.sock");
  const requests = [];
  const server = createServer(socket => {
    socket.write(`${JSON.stringify({ processId: 123, version: "2026", build: "b" })}\n`);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const request = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
      requests.push(request);
      const reply = answer(request, requests.length);
      if (reply) socket.end(`${JSON.stringify({ id: request.id, type: "documents.list", ...reply })}\n`);
    });
    socket.on("error", () => {});
  });
  server.listen(address);
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, connector: () => createConnection(address) };
}

test("AC-10: a document read Revit never answers returns null within the bound, and a later read still gets the list", async (t) => {
  const { requests, connector } = await documentsListener(t, (request, count) => count === 1 ? null : count === 2 ? { status: "busy" } : { status: "succeeded", openDocuments: OPEN, targets: [] });
  const started = Date.now();
  assert.equal(await readOpenDocuments(123, { waitMs: 300, connector }), null, "never answered");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `returned in ${elapsed} ms`);
  assert.equal(await readOpenDocuments(123, { waitMs: 300, connector }), null, "the add-in said busy");
  assert.deepEqual(await readOpenDocuments(123, { waitMs: 300, connector }), OPEN, "the next call reaches Revit");
  assert.equal(requests[0].type, "documents.list");
  assert.equal(requests[0].documents.waitMs, 300);
});

test("a run's document read waits within the run's own time, counted from the connection", async (t) => {
  const { requests, connector } = await documentsListener(t, () => ({ status: "succeeded", openDocuments: OPEN, targets: [targetOf(OPEN[1])] }));
  const response = await readDocuments(123, { targets: ["b-2"], deadline: Date.now() + 2000, connector });
  assert.deepEqual(response.targets, [targetOf(OPEN[1])]);
  assert.deepEqual(requests[0].documents.targets, ["b-2"]);
  assert.ok(requests[0].documents.waitMs > 0 && requests[0].documents.waitMs <= 2000);
});

async function client(t, options) {
  const { server } = createDriveItServer({
    processResolver: async processId => processId ?? 4321,
    sessionReader: async processId => ({ processId, version: "2026", build: "b", connectionIdentity: `pipe-${processId}` }),
    contentReader: async () => ({ projectTemplates: [], familyTemplateFolders: [], libraryFolders: [] }),
    modeResolver: async () => "standard",
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connected = new Client({ name: "drive-it-targets-test", version: "1" });
  await connected.connect(clientTransport);
  t.after(() => connected.close());
  // listTools caches the output schemas the client then enforces on every result.
  return { client: connected, tools: (await connected.listTools()).tools };
}

test("AC-1 (server): get_revit_session returns openDocuments, or null with the rest as before when Revit is busy", async (t) => {
  const { runtime } = await fixture(t);
  let list = OPEN;
  const { client: session } = await client(t, { runtime, documentsReader: async () => list });
  const listed = await session.callTool({ name: "get_revit_session", arguments: {} });
  assert.ok(!listed.isError, listed.content[0].text);
  assert.deepEqual(listed.structuredContent.openDocuments, OPEN);
  assert.equal(listed.structuredContent.openDocuments.filter(row => row.isActive).length, 1);
  list = null;
  const busy = await session.callTool({ name: "get_revit_session", arguments: {} });
  assert.ok(!busy.isError, busy.content[0].text);
  assert.equal(busy.structuredContent.openDocuments, null);
  assert.equal(busy.structuredContent.version, "2026");
  list = [];
  assert.deepEqual((await session.callTool({ name: "get_revit_session", arguments: {} })).structuredContent.openDocuments, []);
});

test("AC-11: every Model Guidance text is in the product as written and within its limit, and the schemas declare the new fields", async (t) => {
  for (const [text, limit] of MODEL_GUIDANCE_LIMITS) assert.ok(text.length <= limit, `${text.length} > ${limit}: ${text}`);
  const { runtime } = await fixture(t);
  const { client: mcp, tools } = await client(t, { runtime, documentsReader: async () => OPEN });
  const tool = name => tools.find(entry => entry.name === name);
  for (const mode of ["standard", "dev"]) {
    const instructions = serverInstructions(mode);
    assert.ok(instructions.includes(DOCUMENTS_GUIDANCE), mode);
    assert.doesNotMatch(instructions, /start the script with revit\.get_active_document\(\)/);
  }
  assert.equal(tool("execute_script").inputSchema.properties.targets.description, TARGETS_DESCRIPTION);
  assert.equal(tool("execute_script").inputSchema.properties.targets.maxItems, 50);
  assert.equal(tool("execute_script").inputSchema.properties.document.description, DOCUMENT_DESCRIPTION);
  assert.ok(tool("get_revit_session").description.includes(OPEN_DOCUMENTS_DESCRIPTION));
  assert.ok(tool("get_revit_session").outputSchema.properties.openDocuments);
  assert.ok(tool("execute_script").outputSchema.properties.targets);
  assert.equal(apiReference("revit.targets")[0].effects, TARGETS_REFERENCE);
  assert.ok(apiReference("revit.get_active_document")[0].effects.endsWith(ACTIVE_DOCUMENT_NOTE));

  // A receipt with targets passes the client's output-schema check.
  const result = await mcp.callTool({ name: "execute_script", arguments: { processId: 123, displayName: "Targets schema", targets: ["b-2", "c-3"], source: "revit.create_level(name='L3', elevation=24)" } });
  assert.ok(!result.isError, result.content.at(-1).text);
  assert.deepEqual(result.structuredContent.targets.map(target => target.title), ["Annex.rvt", "Site.rvt"]);
  const tooMany = await mcp.callTool({ name: "execute_script", arguments: { processId: 123, displayName: "Too many", targets: Array.from({ length: 51 }, (_, index) => `d-${index}`), source: "result = 1" } });
  assert.equal(tooMany.isError, true);
});
