import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../server/runtime.js";

// A stub of the add-in's side of a hold (spec #15): a handle table over a few fake Revit objects,
// Drive-It-owned transactions, and a per-run group that commits or rolls back. It speaks the same
// request and response shapes as src/DriveIt.Revit/Bridge, so the worker's proxies are exercised end to end.
class StubRevit {
  constructor() {
    this.levels = [{ id: 30, name: "Level 1", elevation: 0 }];
    this.nextId = 100;
    this.opened = [];
    this.brokerCalls = [];
  }

  opener() {
    return async (processId, options) => {
      const hold = new StubHold(this, processId, options);
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
      if (operation.type === "create_level") {
        const level = { id: this.nextId++, name: operation.arguments.name, elevation: operation.arguments.elevation };
        (hold ? hold.pending : this.levels).push(level);
        response.changes.push(`Created level '${level.name}' (${level.id}).`);
        response.affectedElements.push(level.id);
      } else if (operation.type === "save_document") {
        if (hold) hold.commitPoint();
        response.changes.push("Saved C:\\model.rvt.");
        response.commitPoint = hold ? true : undefined;
      } else {
        response.status = "failed";
        response.error = { code: "unsupported_operation", message: operation.type };
      }
      response.results.push(null);
    }
    return response;
  }
}

class StubHold {
  constructor(revit, processId, options) {
    Object.assign(this, { revit, processId, options });
    this.sent = [];
    this.handles = new Map();
    this.nextHandle = 0;
    this.pending = [];
    this.transactions = new Map();
    this.nextTransaction = 0;
    this.calls = 0;
    this.listeners = [];
    this.endedWith = null;
    this.summary = null;
    this.document = { kind: "Document", Title: "Tower" };
  }

  onLost(listener) {
    this.listeners.push(listener);
  }

  // The add-in ending the hold on its own: it rolls back and keeps the outcome for hold.result.
  lose(outcome) {
    this.finish(outcome);
    for (const listener of this.listeners.splice(0)) listener();
  }

  commitPoint() {
    this.revit.levels.push(...this.pending);
    this.pending = [];
  }

  finish(outcome) {
    if (this.summary) return this.summary;
    if (outcome === "committed") this.commitPoint();
    else this.pending = [];
    this.summary = { outcome, ms: 5, calls: this.calls, warnings: outcome === "committed" ? [{ description: "Overlap", severity: "warning", elementIds: [1] }] : [], documents: [{ title: "Tower", state: outcome === "committed" ? "committed" : "rolled_back", commitPoint: false }] };
    return this.summary;
  }

  async end(outcome) {
    this.endedWith ??= outcome;
    return this.finish(outcome === "commit" ? "committed" : "rolled_back");
  }

  async send(message) {
    if (this.summary) return { status: "failed", error: { code: this.summary.outcome, message: "Revit is no longer held for this run." } };
    this.sent.push(message);
    this.calls += 1;
    if (message.type === "model.execute") return this.revit.execute(message, this);
    try {
      return { status: "succeeded", value: this.call(message.call) };
    } catch (error) {
      return { status: "failed", error: { code: error.code || "revit_api_error", message: error.message } };
    }
  }

  handle(value) {
    if (value === null || ["number", "string", "boolean"].includes(typeof value)) return value;
    const id = ++this.nextHandle;
    this.handles.set(id, value);
    return { $h: id, type: `Autodesk.Revit.DB.${value.kind}` };
  }

  resolve(node) {
    if (node && typeof node === "object" && "$h" in node) {
      if (!this.handles.has(node.$h)) throw coded("invalid_handle", "This handle is not valid in this run.");
      return this.handles.get(node.$h);
    }
    if (node && typeof node === "object" && "$path" in node) return this.path(node.$path);
    if (Array.isArray(node)) return node.map(item => this.resolve(item));
    return node;
  }

  path(name) {
    const types = {
      "Autodesk.Revit.DB.XYZ": { kind: "Type", name: "XYZ", construct: (x, y, z) => xyz(x, y, z) },
      "Autodesk.Revit.DB.Level": { kind: "Type", name: "Level", Create: (document, elevation) => this.createLevel(elevation) },
      "Autodesk.Revit.DB.Transaction": { kind: "Type", name: "Transaction", construct: () => { throw coded("member_not_allowed", "Drive-It owns every transaction; a script cannot create a Transaction. Put Revit changes inside `with revit.transaction(\"name\"):`."); } },
    };
    if (types[name]) return types[name];
    if (name === "Autodesk.Revit.DB.BuiltInCategory.OST_Levels") return { kind: "Enum", value: "OST_Levels" };
    const owner = name.slice(0, name.lastIndexOf("."));
    if (types[owner]) return { kind: "StaticMethod", type: types[owner], member: name.slice(name.lastIndexOf(".") + 1) };
    throw coded("member_not_found", `'${name}' does not name a Revit API type or member.`);
  }

  createLevel(elevation) {
    if (![...this.transactions.values()].some(open => open)) {
      throw coded("modification_outside_transaction", "Attempt to modify the model outside of transaction. Put Revit changes inside `with revit.transaction(\"name\"):`.");
    }
    const level = { id: this.revit.nextId++, name: `Level ${elevation}`, elevation };
    this.pending.push(level);
    return levelObject(level);
  }

  collection() {
    return { kind: "List", items: [...this.revit.levels, ...this.pending].map(levelObject).concat(Array.from({ length: 600 }, (_, index) => index)) };
  }

  call(call) {
    switch (call.op) {
      case "document":
        if (call.document === null) throw coded("document_not_open", "Call revit.get_active_document() first.");
        return this.handle(this.document);
      case "element": {
        const level = [...this.revit.levels, ...this.pending].find(item => item.id === call.id);
        if (!level) throw coded("element_not_found", `No element has id ${call.id} in Tower.`);
        return this.handle(levelObject(level));
      }
      case "tx.start":
        this.transactions.set(++this.nextTransaction, call.name);
        return this.nextTransaction;
      case "tx.commit":
      case "tx.rollback":
        this.transactions.delete(call.transaction);
        if (call.op === "tx.rollback") this.pending = this.pending.filter(level => level.elevation < 1000);
        return null;
      case "get": {
        const target = this.resolve(call.target);
        if (call.member === "Collector") return this.handle(this.collection());
        if (call.member === "Levels") return this.handle({ ...this.collection(), kind: "Collector" });
        if (typeof target[call.member] === "function") return { $method: call.member };
        if (!(call.member in target)) throw coded("member_not_found", `${target.kind} has no member '${call.member}'. Its members are: ${Object.keys(target).join(", ")}.`);
        return this.handle(target[call.member]);
      }
      case "set": {
        const target = this.resolve(call.target);
        target[call.member] = this.resolve(call.value);
        return null;
      }
      case "call": {
        const target = this.resolve(call.target);
        const args = call.args.map(item => this.resolve(item));
        if (target.kind === "Type") return this.handle(target.construct(...args));
        if (target.kind === "StaticMethod") return this.handle(target.type[target.member](...args));
        return this.handle(target[call.member](...args));
      }
      case "index":
        return this.handle(this.resolve(call.target).items[call.key]);
      case "iter":
      case "next": {
        const source = call.op === "iter" ? { items: this.resolve(call.target).items, at: 0 } : this.handles.get(call.iterator);
        const items = source.items.slice(source.at, source.at + 256).map(item => this.handle(item));
        source.at += 256;
        const done = source.at >= source.items.length;
        const chunk = { items, done };
        if (!done) {
          chunk.$iter = ++this.nextHandle;
          this.handles.set(chunk.$iter, source);
        }
        return chunk;
      }
      case "len": {
        const target = this.resolve(call.target);
        if (target.kind === "Collector") throw coded("no_length", "A Autodesk.Revit.DB.FilteredElementCollector has no length.");
        return target.items.length;
      }
      case "eq": {
        const left = this.resolve(call.target);
        const right = this.resolve(call.other);
        return left === right || (left?.kind === "Enum" && right?.kind === "Enum" && left.value === right.value);
      }
      case "str": {
        const target = this.resolve(call.target);
        return target.kind === "XYZ" ? `(${target.X}, ${target.Y}, ${target.Z})` : `Autodesk.Revit.DB.${target.kind}`;
      }
      default:
        throw coded("invalid_call", `Unknown bridge operation '${call.op}'.`);
    }
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function xyz(x, y, z) {
  return { kind: "XYZ", X: x, Y: y, Z: z, Add(other) { return xyz(this.X + other.X, this.Y + other.Y, this.Z + other.Z); } };
}

function levelObject(level) {
  return {
    kind: "Level",
    Id: { kind: "ElementId", Value: level.id },
    get Name() { return level.name; },
    set Name(value) { level.name = value; },
    Elevation: level.elevation,
  };
}

async function fixture(t, revit, options = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-bridge-")));
  const root = path.join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    brokerExecutor: revit.brokerExecutor(),
    holdOpener: revit.opener(),
    ...options,
  });
  await runtime.workspace.setRoot(root);
  return { root, runtime };
}

let keys = 0;
function run(runtime, source, overrides = {}) {
  return runtime.execute({
    processId: 123,
    displayName: "Bridge test run",
    document: { path: null, uniqueId: "doc-1" },
    source,
    idempotencyKey: `bridge-${++keys}`,
    ...overrides,
  });
}

test("a run that never uses the bridge is never held", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, "revit.create_level(name='L2', elevation=10)\nresult = DB is not None");
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.held, null);
  assert.equal(revit.opened.length, 0);
  assert.equal(revit.brokerCalls.length, 1);
  assert.equal(receipt.warnings, undefined);
});

test("handles support attributes, methods, indexing, iteration, len, == and str", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const source = `
doc = revit.document()
point = DB.XYZ(1, 2, 3)
moved = point.Add(DB.XYZ(1, 1, 1))
again = point.Add(point)
level = revit.element(30)
level.Name = "Ground"
items = list(doc.Collector)
result = {
    "title": doc.Title,
    "x": point.X,
    "moved": [moved.X, moved.Y, moved.Z],
    "again": again.X,
    "str": str(moved),
    "name": revit.element(30).Name,
    "id": level.Id.Value,
    "count": len(items),
    "len": len(doc.Collector),
    "first": doc.Collector[0].Name,
    "eq": DB.BuiltInCategory.OST_Levels == DB.BuiltInCategory.OST_Levels,
    "same": level == level,
    "repr": repr(level),
    "unsized": len(list(doc.Levels)),
}`;
  const receipt = await run(runtime, source);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, {
    title: "Tower", x: 1, moved: [2, 3, 4], again: 2, str: "(2, 3, 4)", name: "Ground", id: 30,
    count: 601, len: 601, first: "Ground", eq: true, same: true, repr: "<Revit Autodesk.Revit.DB.Level handle>", unsized: 601,
  });
  const [hold] = revit.opened;
  assert.equal(revit.opened.length, 1);
  assert.equal(hold.options.runId, receipt.runId);
  assert.equal(hold.options.displayName, "Bridge test run");
  assert.ok(hold.options.timeLimitMs > 0 && hold.options.timeLimitMs <= 30000, hold.options.timeLimitMs);
  assert.equal(hold.endedWith, "commit");
  // The second Add is known to be a method, so it costs one call, not two.
  const adds = hold.sent.filter(message => message.call?.member === "Add");
  assert.deepEqual(adds.map(message => message.call.op), ["get", "call", "call"]);
  // 601 items cross in chunks of 256.
  assert.equal(hold.sent.filter(message => message.call?.op === "next").length, 4, "two walks of 601 items, in chunks of 256");
  assert.deepEqual(receipt.held, { ms: 5, calls: hold.calls });
  assert.deepEqual(receipt.warnings, [{ description: "Overlap", severity: "warning", elementIds: [1] }]);
});

test("transactions commit on leaving the block and roll back when it raises", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const source = `
doc = revit.document()
with revit.transaction("Two levels"):
    a = DB.Level.Create(doc, 10)
    b = DB.Level.Create(doc, 20)
try:
    with revit.transaction("Failed level"):
        DB.Level.Create(doc, 2000)
        raise ValueError("stop here")
except ValueError as error:
    caught = str(error)
result = {"a": a.Id.Value, "caught": caught}`;
  const receipt = await run(runtime, source);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.result.caught, "stop here");
  const ops = revit.opened[0].sent.map(message => message.call?.op).filter(op => op?.startsWith("tx."));
  assert.deepEqual(ops, ["tx.start", "tx.commit", "tx.start", "tx.rollback"]);
  assert.deepEqual(revit.levels.map(level => level.elevation), [0, 10, 20]);
});

test("a held run that fails is rolled back whole, after two committed transactions", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const source = `
doc = revit.document()
with revit.transaction("One"):
    DB.Level.Create(doc, 10)
with revit.transaction("Two"):
    DB.Level.Create(doc, 20)
raise RuntimeError("after two transactions")`;
  const receipt = await run(runtime, source);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "SCRIPT_FAILED");
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.deepEqual(revit.levels.map(level => level.elevation), [0]);
  assert.equal(receipt.held.calls, revit.opened[0].calls);
});

test("a change outside a transaction fails with Revit's error naming revit.transaction", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, "DB.Level.Create(revit.document(), 10)");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "modification_outside_transaction");
  assert.match(receipt.error.message, /revit\.transaction/);
});

test("a script cannot create Revit's own transaction objects", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, "DB.Transaction(revit.document(), 'mine')");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "member_not_allowed");
});

test("bridge errors reach the script as RevitError and teach the member list", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const source = `
try:
    revit.element(30).Height
except Exception as error:
    result = {**error.response["error"], "type": type(error).__name__}
`;
  const receipt = await run(runtime, source);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.result.code, "member_not_found");
  assert.equal(receipt.result.type, "RevitError");
  assert.match(receipt.result.message, /Name/);
});

test("values that cannot cross to Revit and keyword arguments fail in the script", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const dict = await run(runtime, "DB.XYZ({'x': 1}, 0, 0)");
  assert.equal(dict.status, "failed");
  assert.match(dict.error.message, /cannot cross to Revit/);
  const keyword = await run(runtime, "DB.XYZ(x=1, y=0, z=0)");
  assert.equal(keyword.status, "failed");
  assert.match(keyword.error.message, /positional arguments only/);
  assert.equal(revit.opened.length, 0, "nothing reached Revit, so nothing was held");
});

test("built-in operations join the hold once it starts and are restored with it", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const source = `
revit.create_level(name="Before", elevation=5)
doc = revit.document()
revit.create_level(name="Inside", elevation=15)
raise RuntimeError("fail after a held built-in")`;
  const receipt = await run(runtime, source);
  assert.equal(revit.brokerCalls.length, 1, "only the operation before the first bridge call bypasses the hold");
  assert.equal(revit.opened[0].sent.filter(message => message.type === "model.execute").length, 1);
  assert.deepEqual(revit.levels.map(level => level.name), ["Level 1", "Before"]);
  assert.equal(receipt.status, "partially_applied");
  assert.deepEqual(receipt.changes, [`Created level 'Before' (100).`]);
  assert.deepEqual(receipt.affectedElements, [100]);
});

test("a save keeps what came before it when the held run later fails", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const source = `
doc = revit.document()
revit.create_level(name="Kept", elevation=15)
revit.save_document()
revit.create_level(name="Lost", elevation=25)
raise RuntimeError("fail after the save")`;
  const receipt = await run(runtime, source);
  assert.equal(receipt.status, "partially_applied");
  assert.deepEqual(revit.levels.map(level => level.name), ["Level 1", "Kept"]);
  assert.deepEqual(receipt.changes, ["Created level 'Kept' (100).", "Saved C:\\model.rvt."]);
  assert.deepEqual(receipt.affectedElements, [100]);
});

test("a run that succeeds commits its held built-in changes", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, "doc = revit.document()\nrevit.create_level(name='Inside', elevation=15)");
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(revit.levels.map(level => level.name), ["Level 1", "Inside"]);
  assert.deepEqual(receipt.changes, ["Created level 'Inside' (100)."]);
});

test("Stop ends the run at once, rolled back, with stopped_by_user", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const started = Date.now();
  const pending = run(runtime, `
doc = revit.document()
with revit.transaction("Long"):
    DB.Level.Create(doc, 10)
    while True:
        pass`, { timeoutMs: 20000 });
  while (!revit.opened[0]?.sent.some(message => message.call?.op === "call")) await new Promise(resolve => setTimeout(resolve, 20));
  revit.opened[0].lose("stopped_by_user");
  const receipt = await pending;
  assert.ok(Date.now() - started < 10000, "the worker is stopped, not left to time out");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "stopped_by_user");
  assert.deepEqual(revit.levels.map(level => level.elevation), [0]);
  assert.equal(receipt.held.calls, revit.opened[0].calls);
});

test("a held run that times out is rolled back", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
doc = revit.document()
with revit.transaction("Long"):
    DB.Level.Create(doc, 10)
    while True:
        pass`, { timeoutMs: 1500 });
  assert.equal(receipt.status, "timed_out");
  assert.equal(receipt.error.code, "RUN_TIMEOUT");
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.deepEqual(revit.levels.map(level => level.elevation), [0]);
});

test("a hold the add-in ends on its deadline reports timed_out", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const pending = run(runtime, "doc = revit.document()\nwhile True:\n    pass", { timeoutMs: 20000 });
  while (!revit.opened[0]?.sent.length) await new Promise(resolve => setTimeout(resolve, 20));
  revit.opened[0].lose("timed_out");
  const receipt = await pending;
  assert.equal(receipt.status, "timed_out");
  assert.equal(receipt.error.code, "RUN_TIMEOUT");
});

test("a hold that cannot be opened fails the bridge call as RevitError", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit, {
    holdOpener: async () => {
      throw Object.assign(new Error("Revit is busy."), { code: "EBUSY" });
    },
  });
  const receipt = await run(runtime, "revit.document()");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "EBUSY");
  assert.match(receipt.error.message, /could not be held/);
  assert.equal(receipt.held, null);
});

test("a rollback Revit could not complete is reported with the document", async (t) => {
  const revit = new StubRevit();
  const opener = revit.opener();
  const { runtime } = await fixture(t, revit, {
    holdOpener: async (...args) => {
      const hold = await opener(...args);
      hold.end = async () => ({ outcome: "rolled_back", ms: 3, calls: hold.calls, warnings: [], documents: [{ title: "Tower", state: "rollback_failed", commitPoint: false }] });
      return hold;
    },
  });
  const receipt = await run(runtime, "doc = revit.document()\nraise RuntimeError('boom')");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error.code, "rollback_failed");
  assert.match(receipt.error.message, /Tower/);
  assert.equal(receipt.error.cause.code, "SCRIPT_FAILED");
});

test("a held run whose worker dies is failed and restored, keeping only its file effects", async (t) => {
  const revit = new StubRevit();
  const { root, runtime } = await fixture(t, revit);
  const flag = path.join(root, "flag.txt");
  const receipt = await run(runtime, `
import os
doc = revit.document()
with revit.transaction("Killed"):
    DB.Level.Create(doc, 10)
    files.write(args["flag"], "in transaction")
    os._exit(9)`, { arguments: { flag } });
  assert.equal(receipt.status, "failed");
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.deepEqual(revit.levels.map(level => level.elevation), [0]);
  assert.deepEqual(receipt.changes, [{ operation: "write_file", paths: [flag] }]);
});

test("a run waits for a busy Revit within its own time, before and outside a hold", async (t) => {
  const revit = new StubRevit();
  const waits = [];
  const executor = revit.brokerExecutor();
  const { runtime } = await fixture(t, revit, {
    sessionReader: async (processId, options) => {
      waits.push(["session", options?.connectWaitMs]);
      return { processId, version: "2026", build: "test", connectionIdentity: "test-session" };
    },
    brokerExecutor: async (processId, envelope, options) => {
      waits.push(["broker", options?.connectWaitMs]);
      return executor(processId, envelope, options);
    },
  });
  const receipt = await run(runtime, "revit.create_level(name='L2', elevation=10)", { timeoutMs: 20000 });
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(waits.map(([kind]) => kind), ["session", "broker"]);
  for (const [, waitMs] of waits) assert.ok(waitMs > 15000 && waitMs <= 20000, String(waitMs));
});

test("a held run that needs an outside-root decision ends pending, rolled back and released", async (t) => {
  const revit = new StubRevit();
  const { root, runtime } = await fixture(t, revit);
  const outside = path.join(path.dirname(root), "outside.txt");
  const receipt = await run(runtime, `
doc = revit.document()
with revit.transaction("Before the decision"):
    DB.Level.Create(doc, 10)
files.write(args["outside"], "needs a decision")`, { arguments: { outside } });
  assert.equal(receipt.status, "pending");
  assert.ok(receipt.policyRequests.length > 0);
  assert.equal(revit.opened[0].endedWith, "rollback");
  assert.deepEqual(revit.levels.map(level => level.elevation), [0]);
});
