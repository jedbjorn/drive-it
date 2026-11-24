import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../server/runtime.js";

// Spec #16 "The API in Python" and "Calls Refused", worker side. A stub of the add-in's bridge
// (src/DriveIt.Revit/Bridge) that speaks the same shapes for the operations this spec adds: operators,
// isinstance, int, named arguments, boxes, indexed properties, type text, exception classes and notes.

const TYPES = {
  Element: null,
  Wall: "Element",
  Level: "Element",
  XYZ: null,
  ElementId: null,
  ModelCurveArray: null,
  FootPrintRoof: "Element",
  BuiltInCategory: null,
  WorksharingSaveAsOptions: null,
};

function isA(kind, type) {
  for (let current = kind; current; current = TYPES[current]) if (current === type) return true;
  return false;
}

function coded(code, message, exception) {
  return Object.assign(new Error(message), { code, exception });
}

const xyz = (X, Y, Z) => ({ kind: "XYZ", X, Y, Z });
const elementId = Value => ({ kind: "ElementId", Value });

class StubRevit {
  constructor() {
    this.opened = [];
    this.wall = { kind: "Wall", Id: elementId(316400), Name: "Basic Wall", parameters: { WALL_HEIGHT_TYPE: "Level 2" } };
    this.level = { kind: "Level", Id: elementId(30), Name: "Level 1", Elevation: 0 };
  }

  opener() {
    return async (processId, options) => {
      const hold = new StubHold(this, processId, options);
      this.opened.push(hold);
      return hold;
    };
  }

  brokerExecutor() {
    return async (processId, envelope) => ({ id: envelope.id, type: envelope.type, status: "succeeded", changes: [], affectedFiles: [], affectedElements: [], checks: [], results: [] });
  }
}

class StubHold {
  constructor(revit, processId, options) {
    Object.assign(this, { revit, processId, options });
    this.sent = [];
    this.handles = new Map();
    this.nextHandle = 0;
    this.listeners = [];
    this.summary = null;
    this.notes = [];
    const create = {
      kind: "Creation",
      // Like Creation.Document.NewFootPrintRoof(footprint, level, roofType, out ModelCurveArray mapping): a box takes the
      // out parameter; its starting value, or a new array, is what Revit fills.
      NewFootPrintRoof: (args) => {
        if (args.length !== 4 || !args[3].box) throw coded("no_matching_overload", "No NewFootPrintRoof takes these arguments.");
        const mapping = args[3].start ?? { kind: "ModelCurveArray", Size: 0 };
        mapping.Size = 4;
        return { boxes: [mapping], value: { kind: "FootPrintRoof", Id: elementId(316397) } };
      },
    };
    this.document = {
      kind: "Document",
      Title: "Tower",
      Create: create,
      Wall: revit.wall,
      Level: revit.level,
      SynchronizeWithCentral: () => { throw refused("Document", "SynchronizeWithCentral", "synchronize with central"); },
      ReloadLatest: () => { throw refused("Document", "ReloadLatest", "reload latest"); },
      Print: () => { throw refused("Document", "Print", "print"); },
      Regenerate: () => {
        throw coded("revit_api_error", "InvalidOperationException: The document is read-only.", [
          "Autodesk.Revit.Exceptions.InvalidOperationException",
          "Autodesk.Revit.Exceptions.ApplicationException",
          "System.ApplicationException",
        ]);
      },
      // An API that returns a System.Type: the add-in sends its name as text, never a handle.
      ElementType: () => ({ $type: "Autodesk.Revit.DB.Wall" }),
      OfClass: (args) => args[0],
    };
  }

  onLost(listener) {
    this.listeners.push(listener);
  }

  async end(outcome) {
    this.summary ??= { outcome: outcome === "commit" ? "committed" : "rolled_back", ms: 5, calls: this.sent.length, warnings: [], documents: [] };
    return this.summary;
  }

  async send(message) {
    if (this.summary) return { status: "failed", error: { code: this.summary.outcome, message: "Revit is no longer held for this run." } };
    this.sent.push(message);
    this.notes = [];
    try {
      const value = this.call(message.call);
      return { status: "succeeded", value, ...(this.notes.length ? { notes: this.notes } : {}) };
    } catch (error) {
      return { status: "failed", error: { code: error.code || "revit_api_error", message: error.message, ...(error.exception ? { exception: error.exception } : {}) } };
    }
  }

  handle(value) {
    if (value === null || value === undefined || ["number", "string", "boolean"].includes(typeof value)) return value ?? null;
    if (value.$type) return value;
    const id = ++this.nextHandle;
    this.handles.set(id, value);
    return { $h: id, type: value.kind === "Creation" ? "Autodesk.Revit.Creation.Document" : `Autodesk.Revit.DB.${value.kind}` };
  }

  resolve(node) {
    if (node && typeof node === "object" && "$h" in node) return this.handles.get(node.$h);
    if (node && typeof node === "object" && "$path" in node) return this.path(node.$path);
    if (node && typeof node === "object" && "$ref" in node) return { box: true, start: this.resolve(node.$ref) };
    return node;
  }

  path(name) {
    const short = name.replace("Autodesk.Revit.DB.", "");
    if (short in TYPES) return { kind: "Type", name: short };
    const enums = { "BuiltInCategory.OST_Walls": -2000011, "BuiltInCategory.OST_Doors": -2000023 };
    if (short in enums) return { kind: "BuiltInCategory", name: short.split(".")[1], value: enums[short] };
    if (short === "Element.Name.GetValue" || short === "Element.Name.SetValue") return { kind: "Accessor", member: "Name", action: short.endsWith("GetValue") ? "get" : "set" };
    throw coded("member_not_found", `'${name}' does not name a Revit API type or member.`);
  }

  call(call) {
    switch (call.op) {
      case "document":
        return this.handle(this.document);
      case "get": {
        const target = this.resolve(call.target);
        if (call.member === "Parameter" && target.kind === "Wall") return { $indexed: "Parameter" };
        if (["get_Parameter", "set_Parameter"].includes(call.member) && target.kind === "Wall") return { $method: call.member };
        if (call.member === "IntegerValue" && target.kind === "ElementId") {
          this.notes.push("ElementId.IntegerValue is not in Revit 2026's API; Drive-It read ElementId.Value, which replaces it.");
          return target.Value;
        }
        if (typeof target[call.member] === "function") return { $method: call.member };
        if (!(call.member in target)) throw coded("member_not_found", `${target.kind} has no member '${call.member}'.`);
        return this.handle(target[call.member]);
      }
      case "set":
        this.resolve(call.target)[call.member] = this.resolve(call.value);
        return null;
      case "call": {
        const target = this.resolve(call.target);
        const args = call.args.map(item => this.resolve(item));
        if (target.kind === "Type" && target.name === "XYZ") {
          const named = call.named || {};
          if (Object.keys(named).some(key => !["x", "y", "z"].includes(key))) {
            throw coded("no_matching_overload", "No Autodesk.Revit.DB.XYZ.constructor takes these 3 argument(s). It has: XYZ(); XYZ(double x, double y, double z). Named arguments (w) must match a parameter name shown.");
          }
          const values = [...args];
          for (const [key, value] of Object.entries(named)) values[["x", "y", "z"].indexOf(key)] = value;
          return this.handle(xyz(...values));
        }
        if (target.kind === "Type") return this.handle({ kind: target.name, Size: 0 });
        if (target.kind === "Accessor") {
          if (target.action === "get") return this.handle(args[0][target.member]);
          args[0][target.member] = args[1];
          return null;
        }
        if (target.kind === "Wall" && call.member === "get_Parameter") return target.parameters[args[0]];
        if (target.kind === "Wall" && call.member === "set_Parameter") {
          target.parameters[args[0]] = args[1];
          return null;
        }
        const result = target[call.member](args, call.named);
        if (result && typeof result === "object" && "boxes" in result) return { $boxes: result.boxes.map(item => this.handle(item)), value: this.handle(result.value) };
        return this.handle(result);
      }
      case "operator": {
        const operands = call.args.map(item => this.resolve(item));
        const [left, right] = operands;
        if (left?.kind === "XYZ" && right?.kind === "XYZ" && call.operator === "op_Subtraction") return this.handle(xyz(left.X - right.X, left.Y - right.Y, left.Z - right.Z));
        if (left?.kind === "XYZ" && right?.kind === "XYZ" && call.operator === "op_Addition") return this.handle(xyz(left.X + right.X, left.Y + right.Y, left.Z + right.Z));
        if (call.operator === "op_Multiply" && (left?.kind === "XYZ" || right?.kind === "XYZ")) {
          const [vector, factor] = left?.kind === "XYZ" ? [left, right] : [right, left];
          return this.handle(xyz(vector.X * factor, vector.Y * factor, vector.Z * factor));
        }
        if (call.operator === "op_UnaryNegation" && left?.kind === "XYZ") return this.handle(xyz(-left.X, -left.Y, -left.Z));
        if (call.operator === "op_LessThan" && left?.kind === "ElementId" && right?.kind === "ElementId") return left.Value < right.Value;
        if (call.operator === "op_BitwiseOr" && left?.kind === "BuiltInCategory" && right?.kind === "BuiltInCategory") return this.handle({ kind: "BuiltInCategory", value: left.value | right.value });
        throw coded("operator_not_supported", `Revit defines no operator for ${operands.map(item => item?.kind ?? typeof item).join(" and ")}.`);
      }
      case "isinstance": {
        const target = this.resolve(call.target);
        return isA(target.kind, this.resolve(call.type).name);
      }
      case "issubclass":
        return isA(this.resolve(call.type).name, this.resolve(call.base).name);
      case "int": {
        const target = this.resolve(call.target);
        if (target.kind !== "BuiltInCategory") throw coded("no_integer_value", `A ${target.kind} has no integer value; int() takes an enum value.`);
        return target.value;
      }
      case "eq": {
        const left = this.resolve(call.target);
        const right = this.resolve(call.other);
        return left === right || (left?.kind === "BuiltInCategory" && right?.value === left.value);
      }
      case "str": {
        const target = this.resolve(call.target);
        return target.kind === "BuiltInCategory" ? target.name : `Autodesk.Revit.DB.${target.kind}`;
      }
      default:
        throw coded("invalid_call", `Unknown bridge operation '${call.op}'.`);
    }
  }
}

function refused(owner, member, action) {
  return coded("member_not_allowed", `${owner}.${member} leaves the Revit session and cannot be rolled back, so Drive-It does not run it. Ask the user to ${action} in Revit.`);
}

async function fixture(t, revit) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-api-python-")));
  const root = path.join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    brokerExecutor: revit.brokerExecutor(),
    holdOpener: revit.opener(),
  });
  await runtime.workspace.setRoot(root);
  return { base, root, runtime };
}

let keys = 0;
function run(runtime, source, overrides = {}) {
  return runtime.execute({
    processId: 123,
    displayName: "API in Python test run",
    document: { path: null, uniqueId: "doc-1" },
    source,
    idempotencyKey: `api-python-${++keys}`,
    ...overrides,
  });
}

const calls = (revit, op) => revit.opened.flatMap(hold => hold.sent).filter(message => message.call?.op === op).map(message => message.call);

test("operators on Revit values call the operator Revit defines; subtracting two handles works", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
a = DB.XYZ(4, 2, 0)
b = DB.XYZ(1, 2, 0)
d = a - b
s = a + b
m = 2 * b
n = -b
doc = revit.document()
lower = doc.Level.Id < doc.Wall.Id
flags = DB.BuiltInCategory.OST_Walls | DB.BuiltInCategory.OST_Doors
try:
    a < b
    unsupported = None
except RevitError as error:
    unsupported = error.response["error"]["code"]
result = {"d": [d.X, d.Y, d.Z], "s": s.X, "m": m.X, "n": n.X, "lower": lower, "flags": int(flags), "unsupported": unsupported}`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, { d: [3, 0, 0], s: 5, m: 2, n: -1, lower: true, flags: -2000011 | -2000023, unsupported: "operator_not_supported" });
  const subtraction = calls(revit, "operator").find(call => call.operator === "op_Subtraction");
  assert.deepEqual(subtraction.args.map(item => Object.keys(item)), [["$h"], ["$h"]], "both operands cross as handles");
  assert.deepEqual(calls(revit, "operator").find(call => call.operator === "op_Multiply").args[0], 2, "a reflected operator keeps Python's operand order");
});

test("isinstance and GetType answer with comparisons and text, never a System.Type handle", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
doc = revit.document()
wall = doc.Wall
t = wall.GetType()
result = {
    "isWall": isinstance(wall, DB.Wall), "isElement": isinstance(wall, DB.Element), "isLevel": isinstance(wall, DB.Level),
    "again": isinstance(wall, DB.Wall), "tuple": isinstance(wall, (DB.Level, DB.Wall)), "number": isinstance(5, DB.Wall),
    "name": t.Name, "full": t.FullName, "namespace": t.Namespace, "str": str(t), "eqPath": t == DB.Wall, "pathEq": DB.Wall == t,
    "neLevel": t != DB.Level, "subclass": issubclass(t, DB.Element), "fromApi": doc.ElementType().Name,
    "typeof": typeof(DB.Wall).Name, "clr": clr.GetClrType(DB.Level).FullName,
}
doc.OfClass(t)
doc.OfClass(typeof(DB.Level))`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, {
    isWall: true, isElement: true, isLevel: false, again: true, tuple: true, number: false,
    name: "Wall", full: "Autodesk.Revit.DB.Wall", namespace: "Autodesk.Revit.DB", str: "Autodesk.Revit.DB.Wall", eqPath: true, pathEq: true,
    neLevel: true, subclass: true, fromApi: "Wall", typeof: "Wall", clr: "Autodesk.Revit.DB.Level",
  });
  assert.equal(calls(revit, "isinstance").filter(call => call.type.$path === "Autodesk.Revit.DB.Wall").length, 1, "a handle type's answer is kept for the run");
  assert.ok(!calls(revit, "get").some(call => call.member === "GetType"), "GetType never crosses to Revit");
  assert.deepEqual(calls(revit, "call").filter(call => call.member === "OfClass").map(call => call.args), [
    [{ $path: "Autodesk.Revit.DB.Wall" }], [{ $path: "Autodesk.Revit.DB.Level" }],
  ], "a type crosses as its DB path");
  const notRevit = await run(runtime, "result = revit.document().OfClass(revit.document().Create.GetType())");
  assert.equal(notRevit.status, "failed");
  assert.match(notRevit.error.message, /not a Revit API type under DB/);
});

test("named arguments are matched by parameter name, and a wrong name says so", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, "p = DB.XYZ(1, z=3, y=2)\nresult = [p.X, p.Y, p.Z]");
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, [1, 2, 3]);
  assert.deepEqual(calls(revit, "call")[0], { op: "call", target: { $path: "Autodesk.Revit.DB.XYZ" }, args: [1], named: { z: 3, y: 2 } });
  const wrong = await run(runtime, "DB.XYZ(1, 2, w=3)");
  assert.equal(wrong.status, "failed");
  assert.equal(wrong.error.code, "no_matching_overload");
  assert.match(wrong.error.message, /Named arguments \(w\)/);
});

test("enum values compare, convert with int() and print as their name", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
walls = DB.BuiltInCategory.OST_Walls
result = {"int": int(walls), "str": str(walls), "eq": walls == DB.BuiltInCategory.OST_Walls, "ne": walls != DB.BuiltInCategory.OST_Doors}
try:
    int(revit.document())
except RevitError as error:
    result["notEnum"] = error.response["error"]["code"]`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, { int: -2000011, str: "OST_Walls", eq: true, ne: true, notEnum: "no_integer_value" });
});

test("indexed properties work in both spellings, and the IronPython property workarounds are accepted", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
wall = revit.document().Wall
before = wall.Parameter["WALL_HEIGHT_TYPE"]
wall.Parameter["WALL_HEIGHT_TYPE"] = "Roof"
after = wall.get_Parameter("WALL_HEIGHT_TYPE")
name = DB.Element.Name.GetValue(wall)
DB.Element.Name.SetValue(wall, "Exterior")
renamed = DB.Element.Name.__get__(wall)
DB.Element.Name.__set__(wall, "Interior")
result = {"before": before, "after": after, "name": name, "renamed": renamed, "final": wall.Name, "again": wall.Parameter["WALL_HEIGHT_TYPE"]}`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, { before: "Level 2", after: "Roof", name: "Basic Wall", renamed: "Exterior", final: "Interior", again: "Roof" });
  assert.equal(calls(revit, "get").filter(call => call.member === "Parameter").length, 1, "the indexed property is learned once per type");
});

test("clr.Reference and StrongBox receive an out value in .Value, also with a starting value and by name", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
doc = revit.document()
box = clr.Reference[DB.ModelCurveArray]()
roof = doc.Create.NewFootPrintRoof("loops", doc.Level, "type", box)
start = DB.ModelCurveArray()
given = clr.StrongBox[DB.ModelCurveArray](start)
roof2 = doc.Create.NewFootPrintRoof("loops", doc.Level, "type", given)
result = {"roof": roof.GetType().Name, "size": box.Value.Size, "same": given.Value == start, "givenSize": given.Value.Size, "repr": repr(clr.Reference[DB.ModelCurveArray])}`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, { roof: "FootPrintRoof", size: 4, same: true, givenSize: 4, repr: "<clr.Reference[ModelCurveArray]>" });
  const roofs = calls(revit, "call").filter(call => call.member === "NewFootPrintRoof");
  assert.deepEqual(roofs[0].args[3], { $ref: null }, "an empty box crosses with no starting value");
  assert.deepEqual(Object.keys(roofs[1].args[3].$ref), ["$h"], "a starting value crosses as itself");
  const tooMany = await run(runtime, "clr.StrongBox[DB.XYZ](1, 2)");
  assert.equal(tooMany.status, "failed");
  assert.match(tooMany.error.message, /at most one starting value/);
});

test("a Revit exception is still RevitError, matches its .NET classes, and has .Message", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, `
try:
    revit.document().Regenerate()
except RevitError as error:
    result = {"mro": [cls.__module__ + "." + cls.__name__ for cls in type(error).__mro__][:5], "message": error.Message, "code": error.response["error"]["code"]}`);
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.deepEqual(receipt.result, {
    mro: [
      "Autodesk.Revit.Exceptions.InvalidOperationException",
      "Autodesk.Revit.Exceptions.InvalidOperationException",
      "Autodesk.Revit.Exceptions.ApplicationException",
      "System.ApplicationException",
      "__main__.RevitError",
    ],
    message: "InvalidOperationException: The document is read-only.",
    code: "revit_api_error",
  });
  const uncaught = await run(runtime, "revit.document().Regenerate()");
  assert.equal(uncaught.status, "failed");
  assert.deepEqual(uncaught.error, { code: "revit_api_error", message: "InvalidOperationException: The document is read-only." }, "the class chain stays out of the receipt");
});

test("an older spelling the add-in accepts still reads its value", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  const receipt = await run(runtime, "result = revit.document().Wall.Id.IntegerValue");
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.result, 316400);
});

test("synchronize with central, reload latest and print are refused, telling the agent to ask the user", async (t) => {
  const revit = new StubRevit();
  const { runtime } = await fixture(t, revit);
  for (const [call, action] of [
    ["doc.SynchronizeWithCentral(DB.XYZ(0, 0, 0), DB.XYZ(0, 0, 0))", "synchronize with central"],
    ["doc.ReloadLatest(DB.XYZ(0, 0, 0))", "reload latest"],
    ["doc.Print(DB.XYZ(0, 0, 0))", "print"],
  ]) {
    const receipt = await run(runtime, `doc = revit.document()\n${call}`);
    assert.equal(receipt.status, "failed", call);
    assert.equal(receipt.error.code, "member_not_allowed", call);
    assert.match(receipt.error.message, new RegExp(`cannot be rolled back.*Ask the user to ${action} in Revit\\.`), call);
    assert.equal(revit.opened.at(-1).summary.outcome, "rolled_back", `${call}: the run was rolled back`);
  }
});

test("a path in a named argument or a box's starting value goes through the outside-root check", async (t) => {
  const revit = new StubRevit();
  const { base, runtime } = await fixture(t, revit);
  const outside = path.join(base, "elsewhere", "Desk.rfa");
  for (const source of [
    `revit.document().Create.NewFootPrintRoof(1, 2, 3, mapping=args["file"])`,
    `revit.document().Create.NewFootPrintRoof(1, 2, 3, clr.StrongBox[DB.XYZ](args["file"]))`,
  ]) {
    const receipt = await run(runtime, source, { arguments: { file: outside } });
    assert.equal(receipt.status, "pending", source);
  }
});
