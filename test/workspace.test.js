import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathIsInside } from "../server/workspace.js";

test("Windows workspace comparison handles case and rejects sibling prefixes", () => {
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`c:\driveit\models\a.rvt`, path.win32), true);
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`C:\DriveIt`, path.win32), true);
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`C:\DriveIt-other\a.rvt`, path.win32), false);
  assert.equal(pathIsInside(String.raw`C:\DriveIt`, String.raw`D:\DriveIt\a.rvt`, path.win32), false);
});
