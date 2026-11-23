// Built-in Revit primitives (spec #9 Phase A): the worker's call shape, the units helper, and the
// published reference, against a stub broker. Live Revit behaviour is proven on the Windows seat.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SERVER_INSTRUCTIONS } from "../server/app.js";
import { API_VERSION, apiReference } from "../server/reference.js";
import { Runtime } from "../server/runtime.js";

const READ_PRIMITIVES = ["find_elements", "get_parameters", "list_types", "list_views", "get_selection"];
const RESPONSE_PRIMITIVES = ["get_active_document", "set_selection"];

async function fixture(t, brokerExecutor) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-primitives-")));
  const root = path.join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({
    dataDir: path.join(base, "data"),
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    brokerExecutor,
  });
  await runtime.workspace.setRoot(root);
  let runs = 0;
  return source => runtime.execute({ processId: 123, source, idempotencyKey: `run-${++runs}` });
}

// Plays DocumentDispatcher: one results entry per operation, the output only for read primitives.
function stubBroker(envelopes, outputs = {}) {
  return async (processId, envelope) => {
    envelopes.push(envelope);
    return {
      id: envelope.id,
      status: "succeeded",
      document: { uniqueId: "doc-active", title: "Fixture", path: null, kind: "rvt" },
      changes: [],
      affectedFiles: [],
      affectedElements: [],
      checks: [],
      results: envelope.operations.map(operation => outputs[operation.type] ?? null),
    };
  };
}

test("read primitives return the broker's results entry directly", async (t) => {
  const outputs = {
    find_elements: { total: 1, returned: 1, offset: 0, truncated: false, elements: [{ id: 7, name: "Wall" }] },
    get_parameters: [{ id: 7, parameters: [{ name: "Comments", value: null }], type: null }],
    list_types: [{ id: 9, name: "Generic - 200mm" }],
    list_views: [{ id: 11, name: "{3D}", viewType: "ThreeD", capturable: true }],
    get_selection: [{ id: 7, name: "Wall" }],
  };
  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes, outputs));
  const calls = {
    find_elements: "revit.find_elements(\"Walls\")",
    get_parameters: "revit.get_parameters([7])",
    list_types: "revit.list_types(\"Walls\")",
    list_views: "revit.list_views()",
    get_selection: "revit.get_selection()",
  };
  for (const name of READ_PRIMITIVES) {
    const receipt = await run(`result = ${calls[name]}`);
    assert.equal(receipt.status, "succeeded", `${name}: ${JSON.stringify(receipt.error)}`);
    assert.deepEqual(receipt.result, outputs[name], name);
  }
  // Positional arguments and defaults reach the broker; None values are left out.
  assert.deepEqual(envelopes.map(envelope => envelope.operations[0]), [
    { type: "find_elements", arguments: { category: "Walls", kind: "instance", limit: 200, offset: 0 } },
    { type: "get_parameters", arguments: { elementIds: [7], includeType: true } },
    { type: "list_types", arguments: { category: "Walls" } },
    { type: "list_views", arguments: { includeSheets: true, includeTemplates: false } },
    { type: "get_selection", arguments: {} },
  ]);
});

test("get_active_document and set_selection return the full response, and later calls target the active document", async (t) => {
  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes, { find_elements: { total: 0, returned: 0, offset: 0, truncated: false, elements: [] } }));
  const receipt = await run([
    "active = revit.get_active_document()",
    "selected = revit.set_selection(elementIds=[])",
    "walls = revit.find_elements(category='Walls', levelId=31, limit=5, offset=10)",
    "result = {'active': active, 'selected': selected, 'walls': walls}",
  ].join("\n"));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.equal(receipt.result.active.status, "succeeded");
  assert.equal(receipt.result.active.document.uniqueId, "doc-active");
  assert.deepEqual(receipt.result.active.results, [null]);
  assert.equal(receipt.result.selected.status, "succeeded");
  assert.deepEqual(receipt.result.selected.results, [null]);
  assert.deepEqual(receipt.result.walls.elements, []);
  assert.deepEqual(envelopes.map(envelope => [envelope.operations[0].type, envelope.document.uniqueId]), [
    ["get_active_document", null],
    ["set_selection", "doc-active"],
    ["find_elements", "doc-active"],
  ]);
  assert.deepEqual(envelopes[2].operations[0].arguments, { category: "Walls", kind: "instance", levelId: 31, limit: 5, offset: 10 });
});

test("existing operations and revit.execute still return the full broker response", async (t) => {
  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes, { list_types: [{ id: 9 }] }));
  const receipt = await run([
    "level = revit.create_level(name='L2', elevation=4.0)",
    "batch = revit.execute([{'type': 'create_level', 'arguments': {'name': 'L3', 'elevation': 8.0}}, {'type': 'list_types', 'arguments': {'category': 'Walls'}}])",
    "result = {'level': level, 'batch': batch}",
  ].join("\n"));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  const full = {
    id: receipt.runId,
    status: "succeeded",
    document: { uniqueId: "doc-active", title: "Fixture", path: null, kind: "rvt" },
    changes: [],
    affectedFiles: [],
    affectedElements: [],
    checks: [],
  };
  assert.deepEqual(receipt.result.level, { ...full, results: [null] });
  assert.deepEqual(receipt.result.batch, { ...full, results: [null, [{ id: 9 }]] });
});

test("a failed read primitive raises RevitError with the broker's code", async (t) => {
  const run = await fixture(t, async (processId, envelope) => ({
    id: envelope.id,
    status: "failed",
    changes: [], affectedFiles: [], affectedElements: [], checks: [],
    results: [null],
    error: { code: "unknown_category", message: "'Wals' is not a category in 'Fixture'. Closest category names: Walls." },
  }));
  const caught = await run([
    "try:",
    "    revit.find_elements('Wals')",
    "except Exception as error:",
    "    result = error.response['error']['code']",
  ].join("\n"));
  assert.equal(caught.status, "succeeded", JSON.stringify(caught.error));
  assert.equal(caught.result, "unknown_category");
  const uncaught = await run("revit.list_types('Wals')");
  assert.equal(uncaught.status, "failed");
  assert.deepEqual(uncaught.error.code, "unknown_category");
});

test("units converts to and from Revit internal units without a broker call", async (t) => {
  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes));
  const receipt = await run([
    "result = {",
    "  'mm': units.to_internal(304.8, 'mm'), 'cm': units.to_internal(30.48, 'cm'), 'm': units.to_internal(0.3048, 'm'),",
    "  'in': units.to_internal(12, 'in'), 'ft': units.to_internal(2, 'ft'),",
    "  'mm2': units.to_internal(92903.04, 'mm2'), 'm2': units.from_internal(1, 'm2'), 'in2': units.to_internal(144, 'in2'), 'ft2': units.from_internal(3, 'ft2'),",
    "  'deg': units.to_internal(180, 'deg'), 'rad': units.from_internal(1, 'rad'), 'back': units.from_internal(units.to_internal(3000, 'mm'), 'mm'),",
    "}",
    "try:",
    "    units.to_internal(1, 'yd')",
    "except ValueError as error:",
    "    result['error'] = str(error)",
  ].join("\n"));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  const expected = { mm: 1, cm: 1, m: 1, in: 1, ft: 2, mm2: 1, m2: 0.09290304, in2: 1, ft2: 3, deg: Math.PI, rad: 1, back: 3000 };
  for (const [unit, value] of Object.entries(expected)) assert.ok(Math.abs(receipt.result[unit] - value) < 1e-9, `${unit}: ${receipt.result[unit]}`);
  assert.match(receipt.result.error, /Unknown unit 'yd'; valid units are mm, cm, m, in, ft, mm2, m2, in2, ft2, deg, rad\./);
  assert.equal(envelopes.length, 0);
});

test("get_api_reference lists every primitive and units with an example that runs", async (t) => {
  assert.equal(API_VERSION, "revit-2026-alpha.2");
  const names = apiReference().map(entry => entry.name);
  for (const name of [...READ_PRIMITIVES, ...RESPONSE_PRIMITIVES]) assert.ok(names.includes(`revit.${name}`), name);
  assert.ok(names.includes("units.to_internal") && names.includes("units.from_internal"));

  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes));
  for (const name of [...READ_PRIMITIVES, ...RESPONSE_PRIMITIVES, "units.to_internal", "units.from_internal"]) {
    const entry = apiReference(name.includes(".") ? name : `revit.${name}`)[0];
    assert.equal(entry.apiVersion, API_VERSION, name);
    assert.match(entry.example, new RegExp(`^(\\w+ = )?${name.includes(".") ? name.replace(".", "\\.") : `revit\\.${name}`}\\(`), name);
    for (const [key, description] of Object.entries(entry.arguments)) assert.match(description, /^(Required|Optional): /, `${name}.${key}`);
    if (READ_PRIMITIVES.includes(name)) assert.match(entry.results, /^Returns the result directly: /, name);
    if (RESPONSE_PRIMITIVES.includes(name)) assert.match(entry.results, /^Full response/, name);
    const before = envelopes.length;
    const receipt = await run(entry.example);
    assert.equal(receipt.status, "succeeded", `${name}: ${JSON.stringify(receipt.error)}`);
    assert.equal(envelopes.length - before, name.startsWith("units.") ? 0 : 1, name);
    if (!name.startsWith("units.")) assert.equal(envelopes.at(-1).operations[0].type, name, name);
  }
  assert.match(apiReference("revit.get_active_document")[0].effects, /Later calls in the same script target the returned document/);
});

test("the server instructions start work on an open model with get_active_document", () => {
  assert.match(SERVER_INSTRUCTIONS, /When the user refers to the model or family they have open, start the script with revit\.get_active_document\(\), and call get_api_reference for the built-in primitives before writing raw batches\./);
});
