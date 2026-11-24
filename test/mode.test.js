import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideMode, DEV, inspectMarker, modePaths, resolveMode, STANDARD } from "../server/mode.js";

const SID = "S-1-5-21-1-2-3-1001";
const devFile = JSON.stringify({ mode: "dev" });
const standardFile = JSON.stringify({ mode: "standard" });
const marker = (overrides = {}) => ({
  sid: SID,
  owner: "S-1-5-32-544",
  text: JSON.stringify({ mode: "dev", sid: SID }),
  ...overrides,
});

test("dev needs both keys: the user file says dev and this user's admin-owned marker", () => {
  assert.equal(decideMode(devFile, marker()).mode, DEV);
  assert.equal(decideMode(devFile, marker({ owner: "S-1-5-18" })).mode, DEV);
});

test("every other combination is standard", () => {
  const cases = [
    ["no user file", null, marker()],
    ["user file says standard", standardFile, marker()],
    ["user file is not JSON", "{dev", marker()],
    ["user file is an array", "[\"dev\"]", marker()],
    ["user file mode is a different case", JSON.stringify({ mode: "Dev" }), marker()],
    ["marker not checked", devFile, null],
    ["no marker (a hand-written user file)", devFile, marker({ owner: null, text: null })],
    ["marker owned by the user", devFile, marker({ owner: SID })],
    ["marker owned by Users", devFile, marker({ owner: "S-1-5-32-545" })],
    ["marker for another user", devFile, marker({ text: JSON.stringify({ mode: "dev", sid: "S-1-5-21-9" }) })],
    ["marker says standard", devFile, marker({ text: JSON.stringify({ mode: "standard", sid: SID }) })],
    ["marker is not JSON", devFile, marker({ text: "dev" })],
  ];
  for (const [name, userFile, check] of cases) {
    const result = decideMode(userFile, check);
    assert.equal(result.mode, STANDARD, name);
    assert.ok(result.reason, name);
  }
});

test("the files live under LOCALAPPDATA and ProgramData", () => {
  assert.deepEqual(modePaths({ LOCALAPPDATA: "C:\\Users\\Public\\AppData\\Local", ProgramData: "C:\\ProgramData" }), {
    userFile: "C:\\Users\\Public\\AppData\\Local\\DriveIt\\install-mode.json",
    markerDirectory: "C:\\ProgramData\\DriveIt\\dev-mode",
  });
});

test("the resolver reads only the two files, checks the marker only for a dev user file, and fails to standard", async () => {
  const env = { LOCALAPPDATA: "C:\\L", ProgramData: "C:\\P" };
  const inspected = [];
  const inspect = async directory => {
    inspected.push(directory);
    return marker();
  };
  const resolve = (userFile, options = {}) => resolveMode({ platform: "win32", env, readUserFile: async () => userFile, inspect, ...options });

  assert.equal((await resolve(devFile)).mode, DEV);
  assert.deepEqual(inspected, ["C:\\P\\DriveIt\\dev-mode"]);

  inspected.length = 0;
  assert.equal((await resolve(standardFile)).mode, STANDARD);
  assert.equal((await resolve(null)).mode, STANDARD);
  assert.deepEqual(inspected, [], "a standard user file never starts the marker check");

  const failed = await resolve(devFile, { inspect: async () => { throw new Error("powershell missing"); } });
  assert.equal(failed.mode, STANDARD);
  assert.match(failed.reason, /powershell missing/);

  // A mode claim in the environment is not a source.
  assert.equal((await resolveMode({ platform: "win32", env: { ...env, DRIVE_IT_MODE: "dev", DRIVEIT_MODE: "dev" }, readUserFile: async () => null, inspect })).mode, STANDARD);
  assert.equal((await resolveMode({ platform: "linux", env, readUserFile: async () => devFile, inspect })).mode, STANDARD);
});

test("node server/mode.js prints the resolved mode for the installer", async () => {
  const script = fileURLToPath(new URL("../server/mode.js", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script]);
  const result = JSON.parse(stdout);
  assert.ok([STANDARD, DEV].includes(result.mode));
  assert.equal(typeof result.reason, "string");
});

test("on Windows the marker check reads this user's SID and the marker's owner", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "drive-it-marker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = await inspectMarker(directory);
  assert.match(missing.sid, /^S-1-5-21-/);
  assert.equal(missing.owner, null);
  assert.equal(missing.text, null);

  const text = JSON.stringify({ mode: "dev", sid: missing.sid });
  await writeFile(path.join(directory, `${missing.sid}.json`), text);
  const found = await inspectMarker(directory);
  assert.equal(found.sid, missing.sid);
  assert.match(found.owner, /^S-1-5-/);
  assert.equal(found.text, text);
});
