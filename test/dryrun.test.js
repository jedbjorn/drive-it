// Spec #13 (Feature #11): dry runs on execute_script, server and worker side. The add-in is a stub that answers
// as src/DriveIt.Revit/Bridge/HeldRun.cs does; Revit state, images and rollbacks themselves are proven live.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer, SERVER_INSTRUCTIONS } from "../server/app.js";
import { ReferenceImages } from "../server/capture.js";
import { checkedSuccess } from "../server/library.js";
import { DRY_RUN_GUIDANCE } from "../server/reference.js";
import { callOf, DRY_RUN_NOTES, dryRunOpening, dryRunOptions, Runtime } from "../server/runtime.js";

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
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

const DOCUMENT = { uniqueId: "doc-1", title: "Tower", path: "C:\\models\\tower.rvt", kind: "rvt" };
const ACTIONS = [{
  document: "Tower",
  created: { total: 1, truncated: false, groups: [{ category: "Levels", family: null, type: "Level Head", count: 1, elements: [{ id: 100, name: "Inside" }] }] },
  modified: { total: 0, truncated: false, elements: [] },
  deleted: { total: 0, truncated: false, groups: [] },
  alsoTouched: { total: 0, categories: [] },
}];

// The add-in's side of a hold, as far as a dry run needs it: built-in levels and saves, empty transactions, and
// hold.end. A dry-run hold refuses a save as HeldRun does, and ends with its images, actions and worksharing.
class StubRevit {
  constructor({ worksharing = null, exportError = null } = {}) {
    this.levels = ["Level 1"];
    this.opened = [];
    this.brokerCalls = [];
    this.worksharing = worksharing;
    this.exportError = exportError;
  }

  opener() {
    return async (processId, options) => {
      const hold = new StubHold(this, options);
      this.opened.push(hold);
      return hold;
    };
  }

  brokerExecutor() {
    return async (processId, envelope) => {
      this.brokerCalls.push(envelope);
      return this.execute(envelope, null);
    };
  }

  execute(envelope, hold) {
    const response = { id: envelope.id, type: "model.execute", status: "succeeded", changes: [], affectedFiles: [], affectedElements: [], checks: [], results: [] };
    for (const operation of envelope.operations) {
      if (["save_document", "save_as_document", "close_document", "delete_document"].includes(operation.type) && hold?.options.dryRun) {
        return { ...response, status: "failed", error: { code: "not_allowed_in_dry_run", message: `${operation.type} is not allowed in a dry run: it has a lasting effect that cannot be rolled back.` } };
      }
      if (operation.type === "create_level") {
        (hold ? hold.pending : this.levels).push(operation.arguments.name);
        response.changes.push(`Created level '${operation.arguments.name}' (100).`);
        response.affectedElements.push(100);
      } else if (operation.type === "save_document") {
        response.changes.push("Saved C:\\model.rvt.");
      }
      if (hold) (response.effectDocuments ??= []).push({ document: "d1", changes: response.changes.length, affectedElements: response.affectedElements.length, createdViews: 0 });
      response.results.push(null);
    }
    return response;
  }
}

class StubHold {
  constructor(revit, options) {
    Object.assign(this, { revit, options });
    this.pending = [];
    this.sent = [];
    this.endedWith = null;
    this.endExtra = null;
    this.listeners = [];
  }

  onLost(listener) {
    this.listeners.push(listener);
  }

  async send(message) {
    this.sent.push(message);
    if (message.type === "model.execute") return this.revit.execute(message, this);
    const { call } = message;
    if (call.op === "document") return { status: "succeeded", value: { $h: 1, type: "Autodesk.Revit.DB.Document" } };
    if (call.op === "tx.start") return { status: "succeeded", value: 1 };
    if (call.op === "get" && call.member === "Export") return { status: "succeeded", value: { $method: "Export" } };
    if (["call", "set"].includes(call.op)) return { status: "succeeded", value: null };
    if (call.op === "tx.commit") {
      return { status: "succeeded", value: { name: call.transaction, document: "Tower", documentKey: "d1", added: [101], changed: [], deleted: [], totals: { added: 1, changed: 0, deleted: 0 }, truncated: false } };
    }
    return { status: "failed", error: { code: "invalid_call", message: call.op } };
  }

  async end(outcome, extra = {}) {
    this.endedWith = outcome;
    this.endExtra = extra;
    if (outcome === "commit") this.revit.levels.push(...this.pending);
    this.pending = [];
    const summary = {
      outcome: outcome === "commit" ? "committed" : "rolled_back",
      ms: 7,
      calls: this.sent.length,
      warnings: [],
      documents: [{ title: "Tower", state: outcome === "commit" ? "committed" : "rolled_back", commitPoint: false }],
    };
    const evidence = extra.dryRun;
    if (!evidence) return summary;
    summary.actions = ACTIONS;
    if (this.revit.worksharing) summary.worksharing = this.revit.worksharing;
    const exported = evidence.export;
    if (exported) {
      summary.images = [];
      for (const [index, viewId] of exported.views.entries()) {
        const target = exported.targets[index];
        if (this.revit.exportError === viewId) {
          summary.images.push({ viewId, targetPath: target, error: { code: "unsupported_view_type", message: "A sheet cannot be captured." } });
          continue;
        }
        await writeFile(target, png(64, 48));
        summary.images.push({ viewId, viewUniqueId: `u-${viewId}`, viewName: `View ${viewId}`, viewType: "FloorPlan", document: DOCUMENT, targetPath: target, fitDirection: "Horizontal" });
      }
    }
    return summary;
  }
}

async function fixture(t, revit = new StubRevit(), options = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-dryrun-")));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  const references = new ReferenceImages({ launchRoot: path.join(base, "launch"), startTime: async () => null, log: () => {} });
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    brokerExecutor: revit.brokerExecutor(),
    holdOpener: revit.opener(),
    references,
    ...options,
  });
  await runtime.workspace.setRoot(root);
  return { base, root, outside, runtime, revit, references };
}

let keys = 0;
function run(runtime, source, overrides = {}) {
  return runtime.execute({
    processId: 123,
    displayName: "Dry run test",
    document: { path: null, uniqueId: "doc-1" },
    source,
    idempotencyKey: `dry-${++keys}`,
    ...overrides,
  });
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

test("dryRun options: absent or false is a real run, true has no images, and views are checked", () => {
  assert.equal(dryRunOptions(undefined), null);
  assert.equal(dryRunOptions(false), null);
  assert.deepEqual(dryRunOptions(true), { views: [], createdViews: false, pixelSize: 1024 });
  assert.deepEqual(dryRunOptions({ views: [312, "198877", "312"], createdViews: true, pixelSize: 1600 }), { views: ["312", "198877"], createdViews: true, pixelSize: 1600 });
  assert.throws(() => dryRunOptions({ views: ["1", "2", "3", "4", "5"] }), { code: "INVALID_DRY_RUN" });
  assert.throws(() => dryRunOptions({ views: ["0312"] }), { code: "INVALID_DRY_RUN" });
  assert.throws(() => dryRunOptions({ pixelSize: 100 }), { code: "INVALID_DRY_RUN" });
});

test("a dry run using only built-ins is held from its first request and always rolled back, keeping what it did on the receipt", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)\nchecks.record('level made', True)", { dryRun: true });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(revit.brokerCalls.length, 0, "the built-in went through the hold, not around it");
  assert.equal(revit.opened.length, 1);
  assert.equal(revit.opened[0].options.dryRun, true);
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.deepEqual(revit.opened[0].endExtra, { dryRun: { actions: true, export: null } });
  assert.deepEqual(revit.levels, ["Level 1"], "nothing kept");
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.rolledBack, true);
  assert.deepEqual(receipt.changes, ["Created level 'Inside' (100)."], "what would have happened stays on the receipt");
  assert.deepEqual(receipt.affectedElements, [100]);
  assert.deepEqual(receipt.checks, [{ name: "level made", passed: true, observed: null }]);
  assert.deepEqual(receipt.actions, ACTIONS);
  assert.deepEqual(receipt.images, []);
  assert.deepEqual(receipt.skippedFileWrites, []);
  assert.deepEqual(receipt.notes, [DRY_RUN_NOTES.rolledBack, DRY_RUN_NOTES.ids, DRY_RUN_NOTES.realRun]);
  assert.equal("rehearsedBy" in receipt, false, "rehearsedBy is on real runs only");
  assert.equal(receipt.worksharing, undefined);
});

test("a dry run using revit.transaction is rolled back and reports the transaction", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "doc = revit.document()\nwith revit.transaction('Walls'):\n    pass", { dryRun: true });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.equal(receipt.transactions.length, 1);
  assert.deepEqual(receipt.affectedElements, [101]);
  assert.equal(receipt.rolledBack, true);
});

test("a real run is unchanged: dryRun false, rehearsedBy null, and its fingerprint is the call alone", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "revit.create_level(name='Kept', elevation=15)");
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(revit.opened.length, 0, "a real run with only built-ins is never held");
  assert.deepEqual(revit.levels, ["Level 1", "Kept"]);
  assert.equal(receipt.dryRun, false);
  assert.equal(receipt.rehearsedBy, null);
  for (const field of ["rolledBack", "images", "skippedFileWrites", "notes", "actions", "worksharing"]) assert.equal(field in receipt, false, field);
  assert.deepEqual(JSON.parse(receipt.fingerprint), {
    codeHash: receipt.codeHash, script: null, arguments: {}, processId: 123, document: { path: null, uniqueId: "doc-1" },
  });
});

test("dryRun is part of the idempotency fingerprint: a key never crosses between a dry run and a real run", async (t) => {
  const { runtime } = await fixture(t);
  const source = "revit.create_level(name='Inside', elevation=15)";
  const dry = await run(runtime, source, { dryRun: true, idempotencyKey: "shared" });
  await assert.rejects(run(runtime, source, { idempotencyKey: "shared" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(run(runtime, source, { idempotencyKey: "shared", dryRun: { views: ["30"] } }), { code: "IDEMPOTENCY_CONFLICT" });
  const replay = await run(runtime, source, { dryRun: true, idempotencyKey: "shared" });
  assert.equal(replay.runId, dry.runId, "the same dry run replays");
  const real = await run(runtime, source, { idempotencyKey: "real" });
  await assert.rejects(run(runtime, source, { idempotencyKey: "real", dryRun: true }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(callOf(dry.fingerprint), real.fingerprint, "the dry run and the real run are the same call (D12)");
  const changed = await run(runtime, source, { arguments: { other: 1 } });
  assert.notEqual(callOf(dry.fingerprint), changed.fingerprint);
});

test("a dry run that fails is rolled back, never partially applied, and has no actions or images", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)\nraise RuntimeError('after the change')", { dryRun: { views: ["30"] } });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "SCRIPT_FAILED");
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.deepEqual(revit.opened[0].endExtra, {}, "no images or actions are asked for");
  assert.equal(receipt.rolledBack, true);
  assert.deepEqual(receipt.changes, ["Created level 'Inside' (100)."]);
  assert.equal(receipt.actions, undefined);
  assert.deepEqual(receipt.images, []);
  assert.deepEqual(receipt.notes, [DRY_RUN_NOTES.failed, DRY_RUN_NOTES.ids, DRY_RUN_NOTES.realRun]);
});

test("a dry run's first note follows its outcome: only a succeeded one says its changes were applied", () => {
  const opening = (status, code, rolledBack = true) => dryRunOpening({ status, rolledBack, error: code ? { code } : null });
  assert.equal(opening("succeeded"), DRY_RUN_NOTES.rolledBack);
  assert.equal(opening("failed", "SCRIPT_FAILED"), DRY_RUN_NOTES.failed);
  assert.equal(opening("failed", "stopped_by_user"), DRY_RUN_NOTES.stopped);
  assert.equal(opening("timed_out", "RUN_TIMEOUT"), DRY_RUN_NOTES.timedOut);
  assert.equal(opening("denied"), DRY_RUN_NOTES.denied);
  assert.equal(opening("pending"), DRY_RUN_NOTES.pending);
  assert.equal(opening("failed", "rollback_failed", false), DRY_RUN_NOTES.notRolledBack);
  for (const note of [DRY_RUN_NOTES.failed, DRY_RUN_NOTES.timedOut, DRY_RUN_NOTES.stopped, DRY_RUN_NOTES.denied, DRY_RUN_NOTES.pending]) {
    assert.doesNotMatch(note, /applied/);
    assert.match(note, /rolled back: nothing was kept and nothing was saved\.$/);
  }
});

test("a save in a dry run fails with not_allowed_in_dry_run, rolled back", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)\nrevit.save_document()", { dryRun: true });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "not_allowed_in_dry_run");
  assert.match(receipt.error.message, /save_document/);
  assert.equal(receipt.rolledBack, true);
  assert.deepEqual(revit.levels, ["Level 1"]);
});

test("file writes in a dry run are skipped and listed, inside and outside the root, with no decision", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const existing = path.join(root, "keep.txt");
  await writeFile(existing, "original");
  const source = `
import os
files.write(${JSON.stringify(path.join(root, "inside.txt"))}, "a")
files.write(${JSON.stringify(path.join(outside, "outside.txt"))}, "b")
with open(${JSON.stringify(path.join(root, "plain.bin"))}, "wb") as handle:
    handle.write(b"x")
os.makedirs(${JSON.stringify(path.join(root, "made", "deep"))})
files.rename(${JSON.stringify(existing)}, ${JSON.stringify(path.join(root, "renamed.txt"))})
os.remove(${JSON.stringify(existing)})
try:
    files.read(${JSON.stringify(path.join(root, "inside.txt"))})
    read_back = True
except FileNotFoundError:
    read_back = False
result = {"read_back": read_back, "original": files.read(${JSON.stringify(existing)})}
`;
  const receipt = await run(runtime, source, { dryRun: true });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, { read_back: false, original: "original" });
  for (const name of ["inside.txt", "plain.bin", "made", "renamed.txt"]) assert.equal(await exists(path.join(root, name)), false, name);
  assert.equal(await exists(path.join(outside, "outside.txt")), false);
  assert.equal(await readFile(existing, "utf8"), "original");
  assert.deepEqual(receipt.skippedFileWrites, [
    { operation: "write_file", path: path.join(root, "inside.txt"), outsideRoot: false },
    { operation: "write_file", path: path.join(outside, "outside.txt"), outsideRoot: true },
    { operation: "write_file", path: path.join(root, "plain.bin"), outsideRoot: false },
    { operation: "write_directory", path: path.join(root, "made", "deep"), outsideRoot: false },
    { operation: "rename_file", path: existing, outsideRoot: false },
    { operation: "rename_file", path: path.join(root, "renamed.txt"), outsideRoot: false },
    { operation: "delete_file", path: existing, outsideRoot: false },
  ]);
  assert.deepEqual(await runtime.decisions.list(), [], "a skipped write asks nothing");
  assert.deepEqual(receipt.policyRequests, []);
  assert.ok(receipt.notes.includes(DRY_RUN_NOTES.skippedFileWrites));
  assert.equal(receipt.changes.length, 0, "a skipped write is not a change");
});

test("a write a dry run cannot skip is refused with not_allowed_in_dry_run", async (t) => {
  const { root, runtime } = await fixture(t);
  const target = path.join(root, "direct.txt");
  for (const source of [
    `import io\nio.FileIO(${JSON.stringify(target)}, "w")`,
    `import os\nos.open(${JSON.stringify(target)}, os.O_WRONLY | os.O_CREAT)`,
  ]) {
    const receipt = await run(runtime, source, { dryRun: true });
    assert.equal(receipt.status, "failed", source);
    assert.equal(receipt.error.code, "not_allowed_in_dry_run", source);
    assert.equal(await exists(target), false, source);
  }
});

test("a bridge call that writes a file is refused in a dry run, its paths listed, with no decision and nothing sent to Revit", async (t) => {
  for (const mode of [undefined, "dev"]) {
    const { root, outside, runtime, revit } = await fixture(t, new StubRevit(), mode ? { modeResolver: async () => mode } : {});
    for (const [where, folder] of [["inside", root], ["outside", outside]]) {
      for (const [form, statement] of [["call", "doc.Export(TARGET, 'plan')"], ["set", "doc.FilePath = TARGET"]]) {
        const target = path.join(folder, `plans-${form}.dwg`);
        const receipt = await run(runtime, `doc = revit.document()\n${statement.replace("TARGET", JSON.stringify(target))}`, { dryRun: true });
        const label = `${mode ?? "standard"} ${where} ${form}`;
        assert.equal(receipt.status, "failed", label);
        assert.equal(receipt.error.code, "not_allowed_in_dry_run", label);
        assert.match(receipt.error.message, form === "call" ? /^Export would write/ : /^FilePath would write/, label);
        assert.deepEqual(receipt.skippedFileWrites, [{ operation: "write_file", path: target, outsideRoot: where === "outside" }], label);
        assert.deepEqual(receipt.policyRequests, [], label);
        assert.equal(receipt.rolledBack, true, label);
      }
    }
    const sent = revit.opened.flatMap(hold => hold.sent.map(message => message.call?.op));
    assert.ok(!sent.includes("call") && !sent.includes("set"), `no write reaches Revit: ${sent}`);
    assert.deepEqual(await runtime.decisions.list(), [], "a refused write asks nothing");
  }
});

test("a real run's bridge export still goes through the workspace policy to Revit", async (t) => {
  const { root, runtime, revit } = await fixture(t);
  const target = path.join(root, "plans.dwg");
  const receipt = await run(runtime, `doc = revit.document()\ndoc.Export(${JSON.stringify(target)}, 'plan')`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  const call = revit.opened[0].sent.map(message => message.call).find(sent => sent.op === "call");
  assert.deepEqual(call.args, [target, "plan"]);
});

test("in Dev Mode a dry run skips files.* writes but not plain Python I/O, and says so", async (t) => {
  const { root, runtime } = await fixture(t, new StubRevit(), { modeResolver: async () => "dev" });
  const source = `
files.write(${JSON.stringify(path.join(root, "files.txt"))}, "a")
with open(${JSON.stringify(path.join(root, "plain.txt"))}, "w") as handle:
    handle.write("b")
`;
  const receipt = await run(runtime, source, { dryRun: true });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(await exists(path.join(root, "files.txt")), false);
  assert.equal(await readFile(path.join(root, "plain.txt"), "utf8"), "b", "Dev Mode does not intercept plain I/O");
  assert.deepEqual(receipt.skippedFileWrites.map(entry => entry.path), [path.join(root, "files.txt")]);
  assert.ok(receipt.notes.includes(DRY_RUN_NOTES.devFiles));
});

test("named views are exported before the rollback and published with dryRun metadata; a view that fails does not fail the run", async (t) => {
  const { runtime, revit, references } = await fixture(t, new StubRevit({ exportError: "40" }));
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)", { dryRun: { views: ["30", "40"], pixelSize: 512 } });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  const request = revit.opened[0].endExtra.dryRun.export;
  assert.deepEqual({ ...request, targets: request.targets.length }, { views: ["30", "40"], createdViews: false, pixelSize: 512, targets: 2 });
  const [image, failed] = receipt.images;
  assert.deepEqual(failed, { viewId: "40", name: null, type: null, document: null, error: "UNSUPPORTED_VIEW_TYPE", message: "A sheet cannot be captured." });
  assert.equal(image.viewId, "30");
  assert.equal(image.name, "View 30");
  assert.equal(image.type, "FloorPlan");
  assert.equal(image.document, "Tower");
  assert.equal(image.pixelSize, 512);
  assert.equal(image.width, 64);
  assert.ok(image.path.startsWith(references.sessionDirectory), image.path);
  const sidecar = JSON.parse(await readFile(image.sidecarPath, "utf8"));
  assert.equal(sidecar.dryRun, true);
  assert.equal(sidecar.runId, receipt.runId);
  assert.deepEqual(sidecar.relatedRunIds, [receipt.runId]);
  assert.equal(sidecar.view.id, "30");
  assert.equal(sidecar.retention.retained, false);
  for (const target of request.targets) assert.equal(await exists(path.dirname(target)), false, "staging is removed");
});

test("a named view the add-in did not report gets a failed entry in the same error/message shape", async (t) => {
  const { runtime } = await fixture(t, new StubRevit(), { references: null });
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)", { dryRun: { views: ["30"] } });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.images, [{ viewId: "30", name: null, type: null, document: null, error: "IMAGES_UNAVAILABLE", message: "This server has no reference-image folder, so no view was exported." }]);
});

test("with createdViews the add-in may fill the limit of four", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)", { dryRun: { views: ["30"], createdViews: true } });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  const request = revit.opened[0].endExtra.dryRun.export;
  assert.equal(request.createdViews, true);
  assert.equal(request.targets.length, 4);
});

test("a dry run naming views that never reached Revit holds it at the end to export them", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime, "result = 1", { dryRun: { views: ["30"] } });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(revit.opened.length, 1);
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.equal(receipt.images.length, 1);
  assert.ok(receipt.images[0].path);
  const plain = await run(runtime, "result = 1", { dryRun: true });
  assert.equal(revit.opened.length, 1, "without views nothing is held");
  assert.equal(plain.rolledBack, true);
  assert.deepEqual(plain.actions, []);
});

test("a workshared release is reported in worksharing and notes, released or not", async (t) => {
  const released = { document: "Tower", path: "C:\\ws\\local.rvt", released: true, borrowedIds: [316395, 316396], releasedIds: [316395, 316396, 316400], alsoReleasedIds: [316400] };
  const failed = { document: "Annex", path: "C:\\ws\\annex.rvt", released: false, error: "The central model could not be reached.", borrowedIds: [5] };
  const { runtime } = await fixture(t, new StubRevit({ worksharing: [released, failed] }));
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)", { dryRun: true });
  assert.equal(receipt.status, "succeeded", "a failed release does not fail the dry run");
  assert.equal(receipt.rolledBack, true);
  assert.deepEqual(receipt.worksharing, [released, failed]);
  assert.ok(receipt.notes.includes(DRY_RUN_NOTES.released("Tower")));
  assert.ok(receipt.notes.includes(DRY_RUN_NOTES.notReleased("Annex")));
  assert.match(DRY_RUN_NOTES.released("Tower"), /unmodified elements you had borrowed before/);
  assert.match(DRY_RUN_NOTES.notReleased("Annex"), /Relinquish All Mine or Synchronize with Central/);
});

test("a rollback Revit could not complete is failed with rollback_failed and rolledBack false", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit, {
    holdOpener: async (processId, options) => {
      const hold = new StubHold(revit, options);
      const end = hold.end.bind(hold);
      hold.end = async (...args) => ({ ...await end(...args), documents: [{ title: "Tower", state: "rollback_failed", message: "Revit returned Started." }] });
      revit.opened.push(hold);
      return hold;
    },
  });
  const receipt = await run(runtime, "revit.create_level(name='Inside', elevation=15)", { dryRun: true });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "rollback_failed");
  assert.equal(receipt.rolledBack, false);
  assert.equal(receipt.notes[0], DRY_RUN_NOTES.notRolledBack);
  assert.equal(receipt.actions, undefined);
});

test("a dry run is never promotion evidence and get_script never marks it checked", async (t) => {
  const { runtime, root } = await fixture(t);
  assert.equal(checkedSuccess({ status: "succeeded", dryRun: true, checks: [{ name: "a", passed: true }] }), false);
  const { server } = createDriveItServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-dryrun-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  const call = (name, args) => client.callTool({ name, arguments: args });

  const saved = await call("save_script", {
    name: "Checked", purpose: "A checked script", domain: "test", documentKind: "rvt",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, source: "checks.record('ok', True)",
  });
  const { scriptId, revision } = saved.structuredContent.script;
  const document = { path: path.join(root, "model.rvt") };
  const dry = await call("execute_script", { processId: 123, displayName: "Rehearse the checked script", script: { scriptId, revision }, document, dryRun: true });
  assert.ok(!dry.isError, dry.content.at(-1).text);
  assert.equal(dry.structuredContent.dryRun, true);
  assert.match(dry.content.at(-1).text, /^DRY RUN, rolled back/);

  const rejected = await call("promote_script", { scriptId, revision, runId: dry.structuredContent.runId });
  assert.equal(rejected.structuredContent.status, "rejected");
  assert.deepEqual(rejected.structuredContent.unmet, [{ condition: "real_run", expected: "a real run", observed: "a dry run" }]);

  const detail = await call("get_script", { scriptId, revision });
  assert.ok(!detail.isError, detail.content[0].text);
  assert.deepEqual(detail.structuredContent.runs.map(row => [row.dryRun, row.checked]), [[true, false]]);

  const real = await call("execute_script", { processId: 123, displayName: "Run the checked script", script: { scriptId, revision }, document });
  assert.equal(real.structuredContent.dryRun, false);
  assert.equal(real.structuredContent.rehearsedBy, null);
  const promoted = await call("promote_script", { scriptId, revision, runId: real.structuredContent.runId });
  assert.equal(promoted.structuredContent.status, "promoted");
});

test("a dry run's images return inline over MCP, ahead of the receipt", async (t) => {
  const { runtime } = await fixture(t);
  const { server } = createDriveItServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-dryrun-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  const result = await client.callTool({ name: "execute_script", arguments: {
    processId: 123, displayName: "Rehearse a level", source: "revit.create_level(name='Inside', elevation=15)",
    document: { uniqueId: "doc-1" }, dryRun: { views: ["30"] },
  } });
  assert.ok(!result.isError, result.content.at(-1).text);
  assert.deepEqual(result.content.map(item => item.type), ["image", "text"]);
  assert.equal(result.content[0].mimeType, "image/png");
  assert.equal(result.structuredContent.images[0].viewId, "30");
  const invalid = await client.callTool({ name: "execute_script", arguments: {
    processId: 123, displayName: "Too many views", source: "result = 1", dryRun: { views: ["1", "2", "3", "4", "5"] },
  } });
  assert.equal(invalid.isError, true);
});

test("the dry run guidance is in the server instructions and get_api_reference", async (t) => {
  for (const line of DRY_RUN_GUIDANCE) assert.ok(SERVER_INSTRUCTIONS.includes(`- ${line}`), line);
  const { runtime } = await fixture(t);
  const { server } = createDriveItServer({ runtime, processResolver: async () => { throw new Error("no Revit"); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-dryrun-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  const reference = await client.callTool({ name: "get_api_reference", arguments: {} });
  assert.deepEqual(reference.structuredContent.dryRun, DRY_RUN_GUIDANCE);
  const { tools } = await client.listTools();
  const execute = tools.find(tool => tool.name === "execute_script");
  assert.ok(execute.inputSchema.properties.dryRun);
  assert.match(execute.description, /dryRun/);
});
