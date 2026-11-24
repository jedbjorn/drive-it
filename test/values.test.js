import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../server/runtime.js";

// Spec #16 (bridge gaps from the trials): date and time values (C3) and text encodings (C5).
// A stub hold holding one view's sun settings. Like src/DriveIt.Revit/Bridge/BridgeCalls.cs, it reads a
// System.DateTime from {"$datetime": "yyyy-MM-ddTHH:mm:ss.ffffff", "utc": bool}, keeps it as Revit would
// (milliseconds since the epoch and its kind) and writes it back in the same form.
const WIRE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;

function fromWire({ $datetime, utc }) {
  const [, year, month, day, hour, minute, second, micro] = WIRE.exec($datetime).map(Number);
  return { kind: "DateTime", utc: utc === true, ms: Date.UTC(year, month - 1, day, hour, minute, second, micro / 1000) };
}

function toWire(moment) {
  return { $datetime: new Date(moment.ms).toISOString().replace("Z", "000"), utc: moment.utc };
}

class StubHold {
  constructor() {
    this.sent = [];
    this.handles = new Map();
    this.sun = {
      kind: "SunAndShadowSettings",
      StartDateAndTime: { kind: "DateTime", utc: false, ms: Date.UTC(2026, 2, 21, 10, 0, 0) },
      // A value Revit marks as UTC.
      ActiveFrameTime: { kind: "DateTime", utc: true, ms: Date.UTC(2026, 2, 21, 15, 0, 0) },
    };
  }

  onLost() {}

  async end(outcome) {
    return { outcome: outcome === "commit" ? "committed" : "rolled_back", ms: 1, calls: this.sent.length, warnings: [], documents: [] };
  }

  handle(value) {
    if (value?.kind === "DateTime") return toWire(value);
    const id = this.handles.size + 1;
    this.handles.set(id, value);
    return { $h: id, type: `Autodesk.Revit.DB.${value.kind}` };
  }

  async send(message) {
    this.sent.push(message);
    const { call } = message;
    if (call.op === "document") return { status: "succeeded", value: this.handle({ kind: "Document", SunAndShadowSettings: this.sun }) };
    const target = this.handles.get(call.target?.$h);
    if (call.op === "get") return { status: "succeeded", value: this.handle(target[call.member]) };
    if (call.op === "set") {
      if (!call.value || !("$datetime" in call.value)) return { status: "failed", error: { code: "no_matching_overload", message: "StartDateAndTime takes a DateTime." } };
      target[call.member] = fromWire(call.value);
      return { status: "succeeded", value: null };
    }
    if (call.op === "tx.start") return { status: "succeeded", value: 1 };
    if (call.op === "tx.commit") return { status: "succeeded", value: { name: "Sun", document: "Tower", documentKey: "d1", added: [], changed: [], deleted: [], totals: { added: 0, changed: 0, deleted: 0 }, truncated: false } };
    return { status: "failed", error: { code: "invalid_call", message: call.op } };
  }
}

async function fixture(t, hold = new StubHold()) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-values-")));
  const root = path.join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    brokerExecutor: async () => { throw new Error("no broker call expected"); },
    holdOpener: async () => hold,
  });
  await runtime.workspace.setRoot(root);
  return { hold, root, runtime };
}

let keys = 0;
function run(runtime, source, overrides = {}) {
  return runtime.execute({
    processId: 123,
    displayName: "Values test run",
    document: { path: null, uniqueId: "doc-1" },
    source,
    idempotencyKey: `values-${++keys}`,
    ...overrides,
  });
}

function succeeded(receipt) {
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
}

// --- Date and time values (C3; repeat trial run f1d905c9) ---

test("a DateTime Revit returns is a Python datetime, aware in UTC only when Revit marked it so", async (t) => {
  const { runtime } = await fixture(t);
  const receipt = await run(runtime, `
import datetime
sun = revit.document().SunAndShadowSettings
start, frame = sun.StartDateAndTime, sun.ActiveFrameTime
result = [type(start).__name__, start.isoformat(), start.tzinfo is None, frame.isoformat(), frame.tzinfo == datetime.timezone.utc]`);
  succeeded(receipt);
  assert.deepEqual(receipt.result, ["datetime", "2026-03-21T10:00:00", true, "2026-03-21T15:00:00+00:00", true]);
});

test("a datetime set on Revit reads back as the same value, and an aware one as the same instant in UTC", async (t) => {
  const { hold, runtime } = await fixture(t);
  const receipt = await run(runtime, `
import datetime
sun = revit.document().SunAndShadowSettings
with revit.transaction("Sun"):
    sun.StartDateAndTime = datetime.datetime(2026, 6, 21, 17, 30, 0, 250000)
naive = sun.StartDateAndTime
summer = datetime.timezone(datetime.timedelta(hours=2))
with revit.transaction("Sun"):
    sun.StartDateAndTime = datetime.datetime(2026, 6, 21, 19, 30, tzinfo=summer)
aware = sun.StartDateAndTime
result = [naive == datetime.datetime(2026, 6, 21, 17, 30, 0, 250000), aware == datetime.datetime(2026, 6, 21, 19, 30, tzinfo=summer), aware.isoformat()]`);
  succeeded(receipt);
  assert.deepEqual(receipt.result, [true, true, "2026-06-21T17:30:00+00:00"]);
  const sets = hold.sent.filter(message => message.call.op === "set").map(message => message.call.value);
  assert.deepEqual(sets, [
    { $datetime: "2026-06-21T17:30:00.250000", utc: false },
    { $datetime: "2026-06-21T17:30:00.000000", utc: true },
  ]);
});

test("only a datetime is added: a date still cannot cross to Revit", async (t) => {
  const { runtime } = await fixture(t);
  const receipt = await run(runtime, `
import datetime
sun = revit.document().SunAndShadowSettings
sun.StartDateAndTime = datetime.date(2026, 6, 21)`);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.type, "TypeError");
  assert.match(receipt.error.message, /A date cannot cross to Revit/);
});

// --- Text encodings (C5; first trial runs 764b8b7f and e5414bfb) ---

test("a script writes and reads back a UTF-16 file inside the workspace root, and uses Python's other text encodings", async (t) => {
  const { root, runtime } = await fixture(t);
  const file = path.join(root, "shared_params.txt");
  const source = `
text = "# This is a Revit shared parameter file.\\r\\n*META\\tVERSION\\tMINVERSION\\r\\nMETA\\t2\\t1\\r\\n"
with open(args["path"], "w", encoding="utf-16", newline="") as handle:
    handle.write(text)
with open(args["path"], encoding="utf-16", newline="") as handle:
    back = handle.read()
result = [back == text, "é".encode("cp1252").decode("latin-1"), "x".encode("utf-32").decode("utf-32"), "x".encode("utf-16-le").hex(), "ü".encode("cp437").hex()]`;
  const receipt = await run(runtime, source, { arguments: { path: file } });
  succeeded(receipt);
  assert.deepEqual(receipt.result, [true, "é", "x", "7800", "81"]);
  assert.equal((await readFile(file)).subarray(0, 2).toString("hex"), "fffe", "UTF-16 with its byte order mark, as Revit writes it");
  await writeFile(file, Buffer.from("﻿Read back", "utf16le"));
  const read = await run(runtime, "result = open(args['path'], encoding='utf-16').read()", { arguments: { path: file } });
  succeeded(read);
  assert.equal(read.result, "Read back");
});

test("text encodings add nothing a script can import (decision #14)", async (t) => {
  const { runtime } = await fixture(t);
  for (const statement of ["import encodings.utf_16", "import codecs", "from encodings import utf_16", "import _codecs_jp"]) {
    const receipt = await run(runtime, `"x".encode("utf-16")\n${statement}`);
    assert.equal(receipt.status, "failed", statement);
    assert.equal(receipt.error.type, "ImportError", statement);
  }
});
