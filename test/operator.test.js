import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DecisionStore } from "../server/decisions.js";
import { HistoryStore } from "../server/history.js";

const execute = promisify(execFile);
const operator = fileURLToPath(new URL("../server/operator.js", import.meta.url));

test("operator persists roots, binds one-time decisions, and retains run history", {
  skip: process.platform !== "win32" ? "Requires Windows PowerShell" : false,
}, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "drive-it-operator-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const state = path.join(fixture, "state");
  const script = fileURLToPath(new URL("operator.Tests.ps1", import.meta.url));
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-StateDirectory", state, "-FixtureDirectory", fixture,
  ], { timeout: 30000, windowsHide: true });
  assert.match(stdout, /operator tests passed/, stderr);
});

test("direct operator commands persist the root, decide requests, and read history", async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-operator-")));
  const root = path.join(base, "workspace");
  const dataDir = path.join(base, "data");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const run = async (...args) => JSON.parse((await execute(process.execPath, [operator, ...args], {
    env: { ...process.env, DRIVE_IT_DATA_DIR: dataDir },
  })).stdout);

  const selected = await run("workspace", "set", root);
  assert.equal(selected.root, root);
  assert.deepEqual(await run("workspace", "get"), selected);

  const decisions = new DecisionStore(dataDir);
  const pending = await decisions.request("run-1", [{ operation: "write_file", paths: [path.join(base, "outside.txt")] }]);
  const listed = await run("decisions", "list");
  assert.equal(listed[0].id, pending.id);
  const approved = await run("decisions", "approve", pending.id);
  assert.equal(approved.status, "approved");

  const history = new HistoryStore(dataDir);
  await history.save({ runId: "run-1", startedAt: new Date().toISOString(), status: "pending" });
  assert.equal((await run("history", "get", "run-1")).runId, "run-1");
  assert.equal((await run("history", "list"))[0].runId, "run-1");
});
