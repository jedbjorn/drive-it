import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("operator persists roots, binds one-time decisions, and retains run history", {
  skip: process.platform !== "win32" ? "Requires Windows PowerShell" : false,
}, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "drive-it-operator-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const state = join(fixture, "state");
  const script = fileURLToPath(new URL("operator.Tests.ps1", import.meta.url));
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-StateDirectory", state, "-FixtureDirectory", fixture,
  ], { timeout: 30000, windowsHide: true });
  assert.match(stdout, /operator tests passed/, stderr);
});
