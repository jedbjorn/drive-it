import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Runtime } from "../server/runtime.js";
import { SettingsStore } from "../server/settings.js";

const execute = promisify(execFile);
const operator = fileURLToPath(new URL("../server/operator.js", import.meta.url));

async function dataDirectory(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-settings-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test("the script time limit defaults to 120 s and accepts 10 to 600 whole seconds", async (t) => {
  const dataDir = await dataDirectory(t);
  const settings = new SettingsStore(dataDir);
  assert.deepEqual(await settings.get(), { scriptTimeLimitSeconds: 120 });
  assert.deepEqual(await settings.setScriptTimeLimitSeconds(20), { scriptTimeLimitSeconds: 20 });
  assert.deepEqual(await settings.setScriptTimeLimitSeconds("600"), { scriptTimeLimitSeconds: 600 });
  for (const bad of [9, 601, 20.5, "abc", "", -1, null]) {
    await assert.rejects(settings.setScriptTimeLimitSeconds(bad), { code: "INVALID_SETTING" }, String(bad));
  }
  assert.deepEqual(await settings.get(), { scriptTimeLimitSeconds: 600 });
});

test("a hand-edited out-of-range limit reads as the default and other settings survive a save", async (t) => {
  const dataDir = await dataDirectory(t);
  const file = path.join(dataDir, "settings.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify({ scriptTimeLimitSeconds: 100000, other: "kept" }));
  const settings = new SettingsStore(dataDir);
  assert.deepEqual(await settings.get(), { scriptTimeLimitSeconds: 120 });
  await settings.setScriptTimeLimitSeconds(45);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.scriptTimeLimitSeconds, 45);
  assert.equal(saved.other, "kept");
});

test("malformed settings.json reads as the default, and a save replaces it", async (t) => {
  const dataDir = await dataDirectory(t);
  const file = path.join(dataDir, "settings.json");
  const settings = new SettingsStore(dataDir);
  for (const text of ["not json", "[20]", "null", "20"]) {
    await writeFile(file, text);
    assert.deepEqual(await settings.get(), { scriptTimeLimitSeconds: 120 }, text);
    assert.equal(await settings.runTimeoutMs(undefined), 30000, text);
  }
  await writeFile(file, "not json");
  assert.deepEqual(await settings.setScriptTimeLimitSeconds(60), { scriptTimeLimitSeconds: 60 });
  assert.equal(JSON.parse(await readFile(file, "utf8")).scriptTimeLimitSeconds, 60);
});

// Spec #15: the setting applies to future runs. A run started under a higher limit may reach its
// first bridge call (and the add-in's read of the setting) after the limit was lowered, so lowering
// stores how long such a run can still be running; the add-in's hold bound honours it.
test("lowering the limit records until when runs started under the earlier limit may still run", async (t) => {
  const dataDir = await dataDirectory(t);
  const file = path.join(dataDir, "settings.json");
  const settings = new SettingsStore(dataDir);
  const until = async () => Date.parse(JSON.parse(await readFile(file, "utf8")).earlierLimitUntil);

  let before = Date.now();
  await settings.setScriptTimeLimitSeconds(10); // from the 120 s default
  const first = await until();
  assert.ok(first >= before + 120000 && first <= Date.now() + 120000, "now + the earlier 120 s");
  assert.deepEqual(await settings.get(), { scriptTimeLimitSeconds: 10 }, "the record is not part of the setting");

  await settings.setScriptTimeLimitSeconds(60);
  assert.equal(await until(), first, "raising the limit keeps what runs under 120 s may still need");
  await settings.setScriptTimeLimitSeconds(30);
  assert.equal(await until(), first, "lowering from 60 s needs less than 120 s already covers");

  await writeFile(file, JSON.stringify({ scriptTimeLimitSeconds: 600, earlierLimitUntil: new Date(Date.now() - 1000).toISOString() }));
  before = Date.now();
  await settings.setScriptTimeLimitSeconds(20);
  assert.ok(await until() >= before + 600000, "an expired record is replaced by the new one");

  await writeFile(file, JSON.stringify({ scriptTimeLimitSeconds: 20, earlierLimitUntil: new Date(Date.now() - 1000).toISOString() }));
  await settings.setScriptTimeLimitSeconds(30);
  assert.equal(JSON.parse(await readFile(file, "utf8")).earlierLimitUntil, undefined, "nothing to carry once it has passed");
});

test("a run's timeout defaults to 30 s, stays under the limit, and a larger request names the limit", async (t) => {
  const settings = new SettingsStore(await dataDirectory(t));
  assert.equal(await settings.runTimeoutMs(undefined), 30000);
  assert.equal(await settings.runTimeoutMs(120000), 120000);
  await assert.rejects(settings.runTimeoutMs(120001), error => {
    assert.equal(error.code, "TIMEOUT_ABOVE_LIMIT");
    assert.match(error.message, /120 seconds \(120000 ms\)/);
    return true;
  });
  await settings.setScriptTimeLimitSeconds(20);
  assert.equal(await settings.runTimeoutMs(undefined), 20000, "the 30 s default never exceeds a lower setting");
  assert.equal(await settings.runTimeoutMs(5000), 5000);
  await assert.rejects(settings.runTimeoutMs(30000), { code: "TIMEOUT_ABOVE_LIMIT" });
});

test("operator settings commands read and write the limit the runtime enforces", async (t) => {
  const dataDir = await dataDirectory(t);
  const run = args => execute(process.execPath, [operator, ...args], { env: { ...process.env, DRIVE_IT_DATA_DIR: dataDir } });
  assert.deepEqual(JSON.parse((await run(["settings", "get"])).stdout), { scriptTimeLimitSeconds: 120, requireDryRun: false });
  assert.deepEqual(JSON.parse((await run(["settings", "set-time-limit", "20"])).stdout), { scriptTimeLimitSeconds: 20 });
  await assert.rejects(run(["settings", "set-time-limit", "5"]), error => {
    assert.match(error.stderr, /^INVALID_SETTING: .*10 to 600/);
    return true;
  });

  const root = path.join(dataDir, "workspace");
  await mkdir(root);
  const timeouts = [];
  const runtime = new Runtime({
    dataDir,
    sessionReader: async processId => ({ processId, version: "2026", build: "test" }),
    workerRunner: async options => {
      timeouts.push(options.timeoutMs);
      await options.onRequest("broker.execute", { operations: [{ type: "find_elements", arguments: {} }] });
      return { status: "succeeded", result: null, logs: "" };
    },
    brokerExecutor: async (processId, envelope, options) => {
      timeouts.push(options.timeoutMs);
      return { id: envelope.id, status: "succeeded" };
    },
  });
  await runtime.workspace.setRoot(root);
  const receipt = await runtime.execute({ processId: 1, source: "result = 1", idempotencyKey: "default" });
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(timeouts, [20000, 20000], "worker and broker are bounded by the setting");
  await assert.rejects(runtime.execute({ processId: 1, source: "result = 1", idempotencyKey: "too-long", timeoutMs: 21000 }),
    { code: "TIMEOUT_ABOVE_LIMIT" });
  assert.equal(await runtime.history.findIdempotent("too-long"), null, "a rejected request leaves no receipt");
});
