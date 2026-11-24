// Spec #13 "Require Dry Run" and "The dry run shown" (Feature #11, lane C), server and worker side: the setting, the
// rehearsal rule (D12), what the worker and the add-in are told, the worker's refusal of unrehearsed file writes, the
// dry run Staged Actions mode shows, and what the agent is told (AC-14). The add-in is a stub that records what it was
// sent; its refusals themselves are proven live.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer, serverInstructions } from "../server/app.js";
import { DRY_RUN_GUIDANCE } from "../server/reference.js";
import { Runtime } from "../server/runtime.js";
import { SettingsStore } from "../server/settings.js";
import { stagedDryRun } from "../server/staged.js";

const execute = promisify(execFile);
const operator = fileURLToPath(new URL("../server/operator.js", import.meta.url));

// The add-in's side, as far as the rule needs it: it records each hold and batch with what it was told.
class StubRevit {
  constructor() {
    this.holds = [];
    this.batches = [];
  }

  opener() {
    return async (processId, options) => {
      const hold = {
        options,
        sent: [],
        onLost() {},
        send: async message => {
          hold.sent.push(message);
          if (message.type === "model.execute") return this.answer(message);
          const { call } = message;
          if (call.op === "document") return { status: "succeeded", value: { $h: 1, type: "Autodesk.Revit.DB.Document" } };
          if (call.op === "get" && call.member === "Export") return { status: "succeeded", value: { $method: "Export" } };
          return { status: "succeeded", value: call.op === "tx.start" ? 1 : null };
        },
        end: async (outcome, extra = {}) => ({
          outcome: outcome === "commit" ? "committed" : "rolled_back",
          ms: 5,
          calls: hold.sent.length,
          warnings: [],
          documents: [{ title: "Tower", state: outcome === "commit" ? "committed" : "rolled_back", commitPoint: false }],
          ...(extra.dryRun ? { actions: [] } : {}),
        }),
      };
      this.holds.push(hold);
      return hold;
    };
  }

  brokerExecutor() {
    return async (processId, envelope) => {
      this.batches.push(envelope);
      return this.answer(envelope);
    };
  }

  // Refuses an unrehearsed change as the add-in does, so a script sees the code.
  answer(envelope) {
    const changes = envelope.operations.some(operation => operation.type === "create_level");
    if (changes && envelope.requireDryRun?.rehearsed === false) {
      return { id: envelope.id, status: "failed", error: { code: "dry_run_required", message: "Require dry run is on and this run was not rehearsed." } };
    }
    return { id: envelope.id, status: "succeeded", changes: changes ? ["Created level 'L3' (100)."] : [], affectedFiles: [], affectedElements: changes ? [100] : [], checks: [], results: envelope.operations.map(() => null) };
  }
}

async function fixture(t, { session = async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test" }), mode } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-require-")));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  const revit = new StubRevit();
  const dataDir = path.join(base, "data");
  const runtime = new Runtime({ dataDir, sessionReader: session, brokerExecutor: revit.brokerExecutor(), holdOpener: revit.opener(), ...(mode ? { modeResolver: async () => mode } : {}) });
  await runtime.workspace.setRoot(root);
  return { base, root, outside, dataDir, runtime, revit };
}

const LEVEL = "revit.create_level(name='L3', elevation=24)";
let keys = 0;
function run(runtime, source = LEVEL, overrides = {}) {
  return runtime.execute({ processId: 123, displayName: "Add Level 3", source, arguments: { floor: 3 }, idempotencyKey: `require-${++keys}`, ...overrides });
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

test("the setting reads off when missing or malformed, saves on and off, and keeps the other settings", async (t) => {
  const { dataDir } = await fixture(t);
  const file = path.join(dataDir, "settings.json");
  const settings = new SettingsStore(dataDir);
  assert.equal(await settings.requireDryRun(), false, "missing file");
  for (const text of ["not json", "[true]", "null", "true", '{"requireDryRun":"true"}', '{"requireDryRun":1}']) {
    await writeFile(file, text);
    assert.equal(await settings.requireDryRun(), false, text);
  }
  await writeFile(file, JSON.stringify({ scriptTimeLimitSeconds: 45 }));
  assert.deepEqual(await settings.setRequireDryRun("on"), { requireDryRun: true });
  assert.equal(await settings.requireDryRun(), true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { scriptTimeLimitSeconds: 45, requireDryRun: true });
  await settings.setScriptTimeLimitSeconds(60);
  assert.equal(await settings.requireDryRun(), true, "saving the time limit keeps the setting");
  assert.deepEqual(await settings.setRequireDryRun("OFF"), { requireDryRun: false });
  for (const bad of ["yes", "", "1", null, undefined]) {
    await assert.rejects(settings.setRequireDryRun(bad), { code: "INVALID_SETTING" }, String(bad));
  }
  assert.equal(await settings.requireDryRun(), false);
});

test("operator.js settings set-require-dry-run on|off, and settings get returns it", async (t) => {
  const { dataDir } = await fixture(t);
  const cli = args => execute(process.execPath, [operator, ...args], { env: { ...process.env, DRIVE_IT_DATA_DIR: dataDir } });
  assert.deepEqual(JSON.parse((await cli(["settings", "get"])).stdout), { scriptTimeLimitSeconds: 120, requireDryRun: false });
  assert.deepEqual(JSON.parse((await cli(["settings", "set-require-dry-run", "on"])).stdout), { requireDryRun: true });
  assert.deepEqual(JSON.parse((await cli(["settings", "get"])).stdout), { scriptTimeLimitSeconds: 120, requireDryRun: true });
  await assert.rejects(cli(["settings", "set-require-dry-run", "maybe"]), error => {
    assert.match(error.stderr, /^INVALID_SETTING: Require dry run takes on or off/);
    return true;
  });
  assert.deepEqual(JSON.parse((await cli(["settings", "set-require-dry-run", "off"])).stdout), { requireDryRun: false });
});

test("with the setting off nothing is sent and a real run's receipt says rehearsedBy null", async (t) => {
  const { runtime, revit } = await fixture(t);
  const receipt = await run(runtime);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.rehearsedBy, null);
  assert.equal("requireDryRun" in revit.batches[0], false, "no member an older add-in would refuse");
});

test("with the setting on, an unrehearsed run is told so and its change is refused, while a read-only run succeeds", async (t) => {
  const { runtime, revit } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const read = await run(runtime, "result = revit.execute([{'type': 'list_views', 'arguments': {}}])['status']");
  assert.equal(read.status, "succeeded", read.error?.message);
  assert.equal(read.rehearsedBy, null);
  assert.deepEqual(revit.batches[0].requireDryRun, { rehearsed: false });

  const write = await run(runtime);
  assert.equal(write.status, "failed");
  assert.equal(write.error.code, "dry_run_required");
  assert.equal(write.rehearsedBy, null);
  assert.deepEqual(write.changes, []);
});

test("one succeeded, rolled-back dry run allows one real run of the same call, named in rehearsedBy", async (t) => {
  const { runtime, revit } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const dry = await run(runtime, LEVEL, { dryRun: true });
  assert.equal(dry.status, "succeeded", dry.error?.message);
  assert.equal(dry.rolledBack, true);
  assert.equal("requireDryRun" in revit.holds[0].options && revit.holds[0].options.requireDryRun, undefined, "a dry run's hold carries no guard");

  const real = await run(runtime);
  assert.equal(real.status, "succeeded", real.error?.message);
  assert.equal(real.rehearsedBy, dry.runId);
  assert.deepEqual(revit.batches.at(-1).requireDryRun, { rehearsed: true });

  const again = await run(runtime);
  assert.equal(again.rehearsedBy, null, "the dry run allows no further run");
  assert.equal(again.error?.code, "dry_run_required");

  await run(runtime, LEVEL, { dryRun: true });
  const changed = await run(runtime, LEVEL, { arguments: { floor: 4 } });
  assert.equal(changed.rehearsedBy, null, "one argument changed is a different call");
  assert.equal(changed.error?.code, "dry_run_required");
});

test("only a succeeded, rolled-back dry run in the same Revit process rehearses", async (t) => {
  let processId = 123;
  const { runtime, dataDir } = await fixture(t, { session: async () => ({ processId, version: "2026", build: "test", connectionIdentity: "test" }) });
  await runtime.settings.setRequireDryRun("on");
  const failed = await run(runtime, `${LEVEL}\nraise ValueError('no')`, { dryRun: true });
  assert.equal(failed.status, "failed");
  const source = `${LEVEL}\nraise ValueError('no')`;
  assert.equal((await run(runtime, source)).rehearsedBy, null, "a failed dry run allows nothing");

  const dry = await run(runtime, LEVEL, { dryRun: true });
  const stored = JSON.parse(await readFile(path.join(dataDir, "runs", `${dry.runId}.json`), "utf8"));
  await writeFile(path.join(dataDir, "runs", `${dry.runId}.json`), JSON.stringify({ ...stored, rolledBack: false }));
  assert.equal((await run(runtime)).rehearsedBy, null, "a dry run that was not rolled back allows nothing");

  await run(runtime, LEVEL, { dryRun: true });
  processId = 456; // Revit restarted: the process is part of the call
  assert.equal((await run(runtime)).rehearsedBy, null, "a dry run in another Revit process allows nothing");
});

test("two real runs at once take one dry run between them", async (t) => {
  const { runtime } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const dry = await run(runtime, LEVEL, { dryRun: true });
  const both = await Promise.all([run(runtime), run(runtime)]);
  assert.deepEqual(both.map(receipt => receipt.rehearsedBy).sort(), [dry.runId, null].sort());
});

test("a real run pending on an outside-root decision keeps its dry run when retried under the same key", async (t) => {
  const { runtime, outside } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const target = path.join(outside, "read.txt");
  await writeFile(target, "x");
  const source = `files.read(${JSON.stringify(target)})\n${LEVEL}`;
  const dry = await run(runtime, source, { dryRun: true });
  assert.equal(dry.status, "pending", "the dry run's outside-root read waits for a decision");
  await runtime.decisions.decide(dry.policyDecisionIds[0], true);
  const retriedDry = await run(runtime, source, { dryRun: true, idempotencyKey: dry.idempotencyKey });
  assert.equal(retriedDry.status, "succeeded", retriedDry.error?.message);

  const real = await run(runtime, source, { idempotencyKey: "pending-real" });
  assert.equal(real.status, "pending");
  assert.equal(real.rehearsedBy, retriedDry.runId);
  await runtime.decisions.decide(real.policyDecisionIds[0], true);
  const retried = await run(runtime, source, { idempotencyKey: "pending-real" });
  assert.equal(retried.status, "succeeded", retried.error?.message);
  assert.equal(retried.rehearsedBy, retriedDry.runId, "the retry keeps the dry run it took");
});

test("an unrehearsed workspace file write is refused by the worker and nothing is written; a rehearsed one writes", async (t) => {
  const { runtime, root } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const target = path.join(root, "out.txt");
  const routes = {
    files: `files.write(${JSON.stringify(target)}, 'x')`,
    open: `open(${JSON.stringify(target)}, 'w').write('x')`,
    delete: `files.delete(${JSON.stringify(path.join(root, "keep.txt"))})`,
  };
  await writeFile(path.join(root, "keep.txt"), "kept");
  for (const [route, source] of Object.entries(routes)) {
    const receipt = await run(runtime, source);
    assert.equal(receipt.status, "failed", route);
    assert.equal(receipt.error.code, "dry_run_required", route);
    assert.match(receipt.error.message, /Dry-run the same call first/, route);
  }
  assert.equal(await exists(target), false);
  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "kept");

  const dry = await run(runtime, routes.files, { dryRun: true });
  assert.equal(dry.skippedFileWrites.length, 1);
  const real = await run(runtime, routes.files);
  assert.equal(real.status, "succeeded", real.error?.message);
  assert.equal(real.rehearsedBy, dry.runId);
  assert.equal(await readFile(target, "utf8"), "x");
});

// D5, D13: Dev Mode does not mediate plain Python I/O, as in a dry run; files.* writes are refused the same way.
test("Dev Mode: an unrehearsed files.* write is refused the same way, and the rule is the same", async (t) => {
  const { runtime, root, revit } = await fixture(t, { mode: "dev" });
  await runtime.settings.setRequireDryRun("on");
  const target = path.join(root, "dev.txt");
  const refused = await run(runtime, `files.write(${JSON.stringify(target)}, 'x')`);
  assert.equal(refused.error?.code, "dry_run_required");
  assert.equal(await exists(target), false);
  assert.equal((await run(runtime)).error?.code, "dry_run_required");
  assert.deepEqual(revit.batches.at(-1).requireDryRun, { rehearsed: false });
  const dry = await run(runtime, LEVEL, { dryRun: true });
  const real = await run(runtime);
  assert.equal(real.status, "succeeded", real.error?.message);
  assert.equal(real.rehearsedBy, dry.runId);
});

test("an unrehearsed bridge call that writes a file is refused before Revit, with no decision asked", async (t) => {
  const { runtime, revit, outside } = await fixture(t);
  await runtime.settings.setRequireDryRun("on");
  const target = path.join(outside, "schedule.csv");
  const source = `doc = revit.document()\ndoc.Export(${JSON.stringify(path.dirname(target))}, 'schedule.csv', None)`;
  const receipt = await run(runtime, source);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "dry_run_required");
  assert.deepEqual(receipt.policyDecisionIds, []);
  assert.equal(revit.holds[0].sent.some(message => message.call?.op === "call"), false, "the export never reached Revit");
  assert.deepEqual(revit.holds[0].options.requireDryRun, { rehearsed: false }, "the hold is told too");
});

test("Staged Actions shows the newest completed dry run in this workspace, Applied once the same call succeeded for real", async (t) => {
  const { runtime, root, dataDir } = await fixture(t);
  assert.deepEqual(await stagedDryRun(runtime.history, root), { dryRun: null }, "none yet");

  const first = await run(runtime, LEVEL, { dryRun: true });
  let shown = (await stagedDryRun(runtime.history, root)).dryRun;
  assert.equal(shown.runId, first.runId);
  assert.equal(shown.status, "succeeded");
  assert.equal(shown.applied, false);
  assert.deepEqual(shown.actions, []);

  await runtime.settings.setRequireDryRun("on");
  await run(runtime); // the same call, for real
  shown = (await stagedDryRun(runtime.history, root)).dryRun;
  assert.equal(shown.runId, first.runId, "a real run never replaces it");
  assert.equal(shown.applied, true);

  const failed = await run(runtime, `${LEVEL}\nraise ValueError('wrong wall')`, { dryRun: true });
  shown = (await stagedDryRun(runtime.history, root)).dryRun;
  assert.equal(shown.runId, failed.runId, "a newer completed dry run replaces it, whatever its outcome");
  assert.equal(shown.status, "failed");
  assert.match(shown.error.message, /wrong wall/);
  assert.equal(shown.applied, false);

  assert.deepEqual(await stagedDryRun(runtime.history, path.join(root, "elsewhere")), { dryRun: null }, "another workspace's dry runs are not shown");
  const cli = await execute(process.execPath, [operator, "staged", "get"], { env: { ...process.env, DRIVE_IT_DATA_DIR: dataDir } });
  assert.equal(JSON.parse(cli.stdout).dryRun.runId, failed.runId);
});

test("a pending dry run is not shown; the last completed one stays", async (t) => {
  const { runtime, root, outside } = await fixture(t);
  const done = await run(runtime, LEVEL, { dryRun: true });
  const target = path.join(outside, "read.txt");
  await writeFile(target, "x");
  const pending = await run(runtime, `files.read(${JSON.stringify(target)})`, { dryRun: true });
  assert.equal(pending.status, "pending");
  assert.equal((await stagedDryRun(runtime.history, root)).dryRun.runId, done.runId);
});

test("AC-14: get_revit_session reports requireDryRun, and the tool description and API reference carry the guidance", async (t) => {
  const { runtime } = await fixture(t);
  const { server } = createDriveItServer({
    runtime,
    processResolver: async processId => processId ?? 4321,
    sessionReader: async processId => ({ processId, version: "2026", build: "b", connectionIdentity: `pipe-${processId}` }),
    contentReader: async () => ({ projectTemplates: [], familyTemplateFolders: [], libraryFolders: [] }),
    modeResolver: async () => "standard",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-require-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());

  const session = async () => (await client.callTool({ name: "get_revit_session", arguments: {} })).structuredContent;
  assert.equal((await session()).requireDryRun, false);
  await runtime.settings.setRequireDryRun("on");
  assert.equal((await session()).requireDryRun, true, "read when asked, not when the server started");

  const { tools } = await client.listTools();
  const describe = name => tools.find(tool => tool.name === name).description;
  assert.match(describe("get_revit_session"), /requireDryRun/);
  assert.match(describe("execute_script"), /requireDryRun.*dry_run_required.*not_allowed_while_dry_run_required/s);
  const reference = (await client.callTool({ name: "get_api_reference", arguments: {} })).structuredContent.dryRun;
  assert.deepEqual(reference, DRY_RUN_GUIDANCE);
  assert.ok(reference.some(line => /If get_revit_session reports requireDryRun, dry-run every script/.test(line)));
  assert.ok(reference.some(line => /dry_run_required: dry-run the same call/.test(line)));
  assert.ok(reference.some(line => /opens in Staged Actions mode by itself/.test(line)));
  for (const mode of ["standard", "dev"]) assert.match(serverInstructions(mode), /If get_revit_session reports requireDryRun/);
});
