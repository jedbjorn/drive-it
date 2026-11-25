// Flag #52: execute_script's structured content must match its declared outputSchema. An SDK Client that has called
// listTools() validates every result's structuredContent against that schema, and the schema forbids undeclared
// properties, so a receipt field the schema does not list turns the call into MCP error -32602. These receipts come
// from the production Runtime; only Revit's side (the hold and the broker) is stubbed.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer } from "../server/app.js";
import { ReferenceImages } from "../server/capture.js";
import { Runtime } from "../server/runtime.js";

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DOCUMENT = { uniqueId: "doc-1", title: "Tower", path: "C:\\Models\\Tower.rvt", kind: "rvt" };
const ACTIONS = [{
  document: "Tower",
  created: { total: 1, truncated: false, groups: [{ category: "Levels", family: null, type: "Level Head", count: 1, elements: [{ id: 100, name: "L3" }] }] },
  modified: { total: 0, truncated: false, elements: [] },
  deleted: { total: 0, truncated: false, groups: [] },
  alsoTouched: { total: 0, categories: [] },
}];
const WORKSHARING = [{ document: "Tower", path: DOCUMENT.path, released: true, borrowedIds: [5], releasedIds: [5], alsoReleasedIds: [] }];

// Revit's side, combining the dry-run and require-dry-run suites' stubs so one receipt carries every field the
// runtime can set: a hold that reports the documents it changed by title and path, its transactions, warnings,
// actions, worksharing, and the named views it exported (view "40" fails, as a sheet would).
class StubRevit {
  constructor() {
    this.holds = [];
    this.batches = [];
  }

  answer(envelope, hold) {
    const guard = envelope.requireDryRun;
    if (guard && !guard.rehearsed) {
      return { id: envelope.id, status: "failed", error: { code: "dry_run_required", message: "Require dry run is on and this run was not rehearsed." } };
    }
    if (hold && !hold.changed.length) hold.changed.push(DOCUMENT);
    const response = { id: envelope.id, status: "succeeded", changes: ["Created level 'L3' (100)."], affectedFiles: [], affectedElements: [100], checks: [], results: envelope.operations.map(() => null) };
    if (hold) response.effectDocuments = [{ document: "d1", changes: 1, affectedElements: 1, createdViews: 0 }];
    return response;
  }

  brokerExecutor() {
    return async (processId, envelope) => {
      this.batches.push(envelope);
      return this.answer(envelope, null);
    };
  }

  opener() {
    return async (processId, options) => {
      const hold = {
        options,
        sent: [],
        changed: [],
        onLost() {},
        send: async message => {
          hold.sent.push(message);
          if (message.type === "model.execute") return this.answer(message, hold);
          const { call } = message;
          if (call.op === "document") return { status: "succeeded", value: { $h: 1, type: "Autodesk.Revit.DB.Document" } };
          if (call.op === "tx.start") return { status: "succeeded", value: 1 };
          if (call.op === "tx.commit") {
            if (!hold.changed.length) hold.changed.push(DOCUMENT);
            return { status: "succeeded", value: { name: "Walls", document: "Tower", documentKey: "d1", added: [101], changed: [], deleted: [], totals: { added: 1, changed: 0, deleted: 0 }, truncated: false } };
          }
          return { status: "succeeded", value: null };
        },
        end: async (outcome, extra = {}) => {
          const state = outcome === "commit" ? "committed" : "rolled_back";
          const summary = {
            outcome: state,
            ms: 5,
            calls: hold.sent.length,
            warnings: [{ description: "Highlighted walls overlap.", severity: "Warning", elementIds: [100, 101] }],
            documents: hold.changed.map(document => ({ title: document.title, path: document.path, state, commitPoint: false })),
          };
          const evidence = extra.dryRun;
          if (!evidence) return summary;
          summary.actions = ACTIONS;
          summary.worksharing = WORKSHARING;
          if (evidence.export) {
            summary.images = [];
            for (const [index, viewId] of evidence.export.views.entries()) {
              const target = evidence.export.targets[index];
              if (viewId === "40") {
                summary.images.push({ viewId, targetPath: target, error: { code: "unsupported_view_type", message: "A sheet cannot be captured." } });
                continue;
              }
              await writeFile(target, png(64, 48));
              summary.images.push({ viewId, viewUniqueId: `u-${viewId}`, viewName: `View ${viewId}`, viewType: "FloorPlan", document: DOCUMENT, targetPath: target, fitDirection: "Horizontal" });
            }
          }
          return summary;
        },
      };
      this.holds.push(hold);
      return hold;
    };
  }
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-output-schema-")));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  const revit = new StubRevit();
  const dataDir = path.join(base, "data");
  const references = new ReferenceImages({ launchRoot: path.join(base, "launch"), startTime: async () => null, log: () => {} });
  const runtime = new Runtime({
    dataDir,
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    brokerExecutor: revit.brokerExecutor(),
    holdOpener: revit.opener(),
    references,
  });
  await runtime.workspace.setRoot(root);
  const { server } = createDriveItServer({ runtime, references, dataDir, processResolver: async processId => processId ?? 123 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-output-schema-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  // listTools caches the output schemas the SDK client then enforces on every call; without it nothing is checked.
  const { tools } = await client.listTools();
  assert.ok(tools.find(tool => tool.name === "execute_script").outputSchema, "execute_script declares an output schema");
  return { base, root, outside, dataDir, runtime, revit, client };
}

// A dry run that creates a level, commits a revit.transaction and skips a file write, so its receipt carries
// transactions, warnings, changedDocuments, actions, worksharing, images (one published, one failed),
// skippedFileWrites and notes.
function everything(root) {
  return `revit.create_level(name='L3', elevation=24)
doc = revit.document()
with revit.transaction('Walls'):
    pass
files.write(${JSON.stringify(path.join(root, "out.txt"))}, "a")`;
}

let keys = 0;
function call(client, args) {
  return client.callTool({ name: "execute_script", arguments: { processId: 123, displayName: "Output schema test", idempotencyKey: `schema-${++keys}`, ...args } });
}

test("a succeeded dry run's receipt, with every dry-run field, passes the client's output-schema check", async (t) => {
  const { client, root } = await fixture(t);
  const result = await call(client, { source: everything(root), dryRun: { views: ["30", "40"] } });
  const receipt = result.structuredContent;
  assert.ok(!result.isError, result.content.at(-1).text);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.dryRun, true);
  assert.deepEqual(receipt.changedDocuments, [{ title: "Tower", path: "C:\\Models\\Tower.rvt" }]);
  assert.equal(receipt.transactions.length, 1);
  assert.equal(receipt.warnings.length, 1);
  assert.deepEqual(receipt.actions, ACTIONS);
  assert.deepEqual(receipt.worksharing, WORKSHARING);
  assert.equal(receipt.images.length, 2);
  assert.ok(receipt.images[0].path);
  assert.equal(receipt.images[1].error, "UNSUPPORTED_VIEW_TYPE");
  assert.equal(receipt.skippedFileWrites.length, 1);
  assert.ok(receipt.notes.length > 0);
});

test("a dry run that never reached Revit (changedDocuments empty) passes the client's output-schema check", async (t) => {
  const { client } = await fixture(t);
  const result = await call(client, { source: "result = 1", dryRun: true });
  assert.ok(!result.isError, result.content.at(-1).text);
  assert.deepEqual(result.structuredContent.changedDocuments, []);
});

test("a failed dry run's receipt passes the client's output-schema check, which runs on error results too", async (t) => {
  const { client } = await fixture(t);
  const result = await call(client, { source: "revit.create_level(name='L3', elevation=24)\nraise RuntimeError('after the change')", dryRun: { views: ["30"] } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.rolledBack, true);
  assert.deepEqual(result.structuredContent.changedDocuments, [{ title: "Tower", path: "C:\\Models\\Tower.rvt" }]);
});

test("a pending dry run's receipt passes the client's output-schema check", async (t) => {
  const { client, outside } = await fixture(t);
  const target = path.join(outside, "read.txt");
  await writeFile(target, "x");
  const result = await call(client, { source: `files.read(${JSON.stringify(target)})`, dryRun: true });
  assert.ok(!result.isError, result.content.at(-1).text);
  assert.equal(result.structuredContent.status, "pending");
  assert.deepEqual(result.structuredContent.changedDocuments, []);
});

test("a real run's receipt passes the client's output-schema check and carries no changedDocuments", async (t) => {
  const { client } = await fixture(t);
  const result = await call(client, { source: "revit.create_level(name='L3', elevation=24)" });
  assert.ok(!result.isError, result.content.at(-1).text);
  assert.equal(result.structuredContent.dryRun, false);
  assert.equal(result.structuredContent.rehearsedBy, null);
  assert.equal("changedDocuments" in result.structuredContent, false);
});

test("a rehearsed real run's receipt, with rehearsedBy set, passes the client's output-schema check", async (t) => {
  const { client, runtime } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const source = "revit.create_level(name='L3', elevation=24)";
  const dry = await call(client, { source, dryRun: true });
  assert.ok(!dry.isError, dry.content.at(-1).text);
  const real = await call(client, { source });
  assert.ok(!real.isError, real.content.at(-1).text);
  assert.equal(real.structuredContent.status, "succeeded");
  assert.equal(real.structuredContent.rehearsedBy, dry.structuredContent.runId);
  assert.equal("changedDocuments" in real.structuredContent, false);
  const refused = await call(client, { source });
  assert.equal(refused.isError, true, "the dry run allows one real run");
  assert.equal(refused.structuredContent.error.code, "dry_run_required");
});

test("a stored receipt written before dry runs still replays through the client's output-schema check", async (t) => {
  const { client, dataDir } = await fixture(t);
  const args = { source: "result = 1", idempotencyKey: "stored-before-dry-runs" };
  const first = await call(client, args);
  assert.ok(!first.isError, first.content.at(-1).text);
  const file = path.join(dataDir, "runs", `${first.structuredContent.runId}.json`);
  const stored = JSON.parse(await readFile(file, "utf8"));
  for (const field of ["mode", "createdViews", "held", "dryRun", "rehearsedBy"]) delete stored[field];
  await writeFile(file, JSON.stringify(stored));
  const replay = await call(client, args);
  assert.ok(!replay.isError, replay.content.at(-1).text);
  assert.equal(replay.structuredContent.runId, first.structuredContent.runId);
  assert.equal("dryRun" in replay.structuredContent, false);
});
