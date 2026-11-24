import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DecisionStore } from "../server/decisions.js";
import { DEV, STANDARD } from "../server/mode.js";
import { pathIsInside, WorkspacePolicy } from "../server/workspace.js";

test("Windows workspace comparison handles case and rejects sibling prefixes", () => {
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`c:\driveit\models\a.rvt`, path.win32), true);
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`C:\DriveIt`, path.win32), true);
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`C:\DriveIt-other\a.rvt`, path.win32), false);
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`D:\DriveIt\a.rvt`, path.win32), false);
});

test("outside the root, standard asks for a decision; Dev Mode allows every path and writes no decision row", async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-policy-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace");
  await mkdir(root);
  const requests = [{ operation: "write_file", paths: [path.join(base, "outside.txt")] }];

  const standardDecisions = new DecisionStore(path.join(base, "standard"));
  const standard = await new WorkspacePolicy(standardDecisions, async () => STANDARD).authorize("run", requests, root);
  assert.equal(standard.status, "pending");
  assert.equal((await standardDecisions.list()).length, 1);

  const devDecisions = new DecisionStore(path.join(base, "dev"));
  const dev = await new WorkspacePolicy(devDecisions, async () => DEV).authorize("run", requests, root);
  assert.deepEqual(dev, { status: "allowed", requests, root });
  assert.deepEqual(await devDecisions.list(), []);
});
