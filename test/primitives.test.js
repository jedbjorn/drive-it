// Built-in Revit primitives (spec #9 Phases A, B and C): the worker's call shape, the units helper, and the
// published reference, against a stub broker. Live Revit behaviour is proven on the Windows seat.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SERVER_INSTRUCTIONS } from "../server/app.js";
import { API_VERSION, apiReference } from "../server/reference.js";
import { Runtime } from "../server/runtime.js";

const READ_PRIMITIVES = ["find_elements", "get_parameters", "list_types", "list_views", "get_selection", "get_family_parameters"];
const RESPONSE_PRIMITIVES = ["get_active_document", "set_selection", "set_parameters", "set_family_parameters", "edit_family"];

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
    get_family_parameters: { types: ["A", "B"], currentType: "A", parameters: [{ name: "Manufacturer", values: { A: { value: null, display: null } } }] },
  };
  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes, outputs));
  const calls = {
    find_elements: "revit.find_elements(\"Walls\")",
    get_parameters: "revit.get_parameters([7])",
    list_types: "revit.list_types(\"Walls\")",
    list_views: "revit.list_views()",
    get_selection: "revit.get_selection()",
    get_family_parameters: "revit.get_family_parameters()",
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
    { type: "get_family_parameters", arguments: {} },
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

test("set_parameters sends its changes as one operation and returns the full response", async (t) => {
  const envelopes = [];
  const run = await fixture(t, stubBroker(envelopes));
  const changes = [
    { elementId: 7, parameter: "Comments", value: "Checked" },
    { elementId: 7, builtIn: "WALL_USER_HEIGHT_PARAM", value: 12.5 },
    { elementId: 8, guid: "0b1fbd65-2c43-4a35-8e8c-4c0b5b6c1d2e", valueString: "1200 mm" },
  ];
  const receipt = await run([
    "revit.get_active_document()",
    `changed = revit.set_parameters(${JSON.stringify(changes)})`,
    "batch = revit.execute([{'type': 'set_parameters', 'arguments': {'changes': [{'elementId': 9, 'parameter': 'Mark', 'value': 'A'}]}}, {'type': 'get_parameters', 'arguments': {'elementIds': [9]}}])",
    "result = {'changed': changed, 'batch': batch}",
  ].join("\n"));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.equal(receipt.result.changed.status, "succeeded");
  assert.equal(receipt.result.changed.document.uniqueId, "doc-active");
  assert.deepEqual(receipt.result.changed.results, [null]);
  assert.deepEqual(envelopes[1].operations, [{ type: "set_parameters", arguments: { changes } }]);
  assert.equal(envelopes[1].document.uniqueId, "doc-active");
  assert.deepEqual(envelopes[2].operations.map(operation => operation.type), ["set_parameters", "get_parameters"]);
  assert.deepEqual(receipt.result.batch.results, [null, null]);
});

test("edit_family returns the full response and later calls target the opened family", async (t) => {
  const envelopes = [];
  const family = { uniqueId: "doc-family", title: "Desk", path: null, kind: "rfa", familyTypes: ["A", "B"] };
  const run = await fixture(t, async (processId, envelope) => {
    envelopes.push(envelope);
    const type = envelope.operations[0].type;
    return {
      id: envelope.id,
      status: "succeeded",
      document: type === "get_active_document" ? { uniqueId: "doc-project", title: "Project", path: null, kind: "rvt" } : family,
      changes: type === "edit_family" ? ["Opened family Desk for editing."] : [],
      affectedFiles: [],
      affectedElements: [],
      checks: [],
      results: envelope.operations.map(operation => operation.type === "get_family_parameters" ? { types: ["A", "B"], currentType: "A", parameters: [] } : null),
    };
  });
  const changes = [
    { parameter: "Manufacturer", type: "A", value: "Acme" },
    { parameter: "Width", allTypes: true, valueString: "600 mm" },
    { parameter: "Depth", allTypes: true, formula: "Width / 2" },
    { parameter: "Height", type: "B", formula: "Width * 2" },
  ];
  const receipt = await run([
    "revit.get_active_document()",
    "opened = revit.edit_family(familyId=42)",
    "params = revit.get_family_parameters()",
    `changed = revit.set_family_parameters(${JSON.stringify(changes).replaceAll("true", "True")})`,
    "result = {'opened': opened, 'params': params, 'changed': changed}",
  ].join("\n"));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.equal(receipt.result.opened.status, "succeeded");
  assert.equal(receipt.result.opened.document.uniqueId, "doc-family");
  assert.deepEqual(receipt.result.opened.changes, ["Opened family Desk for editing."]);
  assert.deepEqual(receipt.result.opened.results, [null]);
  assert.deepEqual(receipt.result.params, { types: ["A", "B"], currentType: "A", parameters: [] });
  assert.equal(receipt.result.changed.status, "succeeded");
  assert.deepEqual(receipt.result.changed.results, [null]);
  assert.deepEqual(envelopes.map(envelope => [envelope.operations[0].type, envelope.document.uniqueId]), [
    ["get_active_document", null],
    ["edit_family", "doc-project"],
    ["get_family_parameters", "doc-family"],
    ["set_family_parameters", "doc-family"],
  ]);
  assert.deepEqual(envelopes[1].operations[0].arguments, { familyId: 42 });
  assert.deepEqual(envelopes[2].operations[0].arguments, {});
  assert.deepEqual(envelopes[3].operations, [{ type: "set_family_parameters", arguments: { changes } }]);
});

test("a rejected set_parameters raises RevitError with the broker's code", async (t) => {
  const run = await fixture(t, async (processId, envelope) => ({
    id: envelope.id,
    status: "failed",
    changes: [], affectedFiles: [], affectedElements: [], checks: [],
    results: [null],
    error: { code: "parameter_read_only", message: "'Length' on element 7 is read-only." },
  }));
  const receipt = await run([
    "try:",
    "    revit.set_parameters([{'elementId': 7, 'parameter': 'Length', 'value': 3.0}], document={'uniqueId': 'doc-active'})",
    "except Exception as error:",
    "    result = error.response['error']['code']",
  ].join("\n"));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.equal(receipt.result, "parameter_read_only");
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
  assert.equal(API_VERSION, "revit-2026-alpha.4");
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
    if (!name.startsWith("units.")) {
      assert.match(entry.arguments.document, /^Optional: .*defaults to the script's current document, which get_active_document and edit_family set/, name);
    }
    if (READ_PRIMITIVES.includes(name)) assert.match(entry.results, /^Returns the result directly: /, name);
    if (RESPONSE_PRIMITIVES.includes(name)) assert.match(entry.results, /^Full response/, name);
    const before = envelopes.length;
    const receipt = await run(entry.example);
    assert.equal(receipt.status, "succeeded", `${name}: ${JSON.stringify(receipt.error)}`);
    assert.equal(envelopes.length - before, name.startsWith("units.") ? 0 : 1, name);
    if (!name.startsWith("units.")) assert.equal(envelopes.at(-1).operations[0].type, name, name);
  }
  assert.match(apiReference("revit.get_active_document")[0].effects, /Later calls in the same script target the returned document/);
  const setParameters = apiReference("revit.set_parameters")[0];
  for (const code of ["element_not_found", "parameter_not_found", "ambiguous_parameter", "parameter_read_only", "value_type_mismatch"]) {
    assert.match(setParameters.effects, new RegExp(code), code);
  }
  assert.match(setParameters.effects, /Drive It model batch/);
  assert.match(setParameters.results, /parameter_readback/);
  const setFamilyParameters = apiReference("revit.set_family_parameters")[0];
  for (const code of ["wrong_document_kind", "family_type_not_found", "parameter_not_found", "parameter_has_formula", "value_type_mismatch", "invalid_formula"]) {
    assert.match(setFamilyParameters.effects, new RegExp(code), code);
  }
  assert.match(setFamilyParameters.effects, /original current type is restored/);
  assert.match(setFamilyParameters.results, /family_parameter_readback/);
  const editFamily = apiReference("revit.edit_family")[0];
  assert.match(editFamily.effects, /Later calls in the same script target the returned document/);
  for (const code of ["family_not_editable", "element_not_found"]) assert.match(editFamily.effects, new RegExp(code), code);
  assert.match(editFamily.effects, /project is not modified/);
  assert.match(apiReference("revit.get_family_parameters")[0].effects, /without changing the current type/);
});

test("the server instructions start work on an open model with get_active_document", () => {
  assert.match(SERVER_INSTRUCTIONS, /When the user refers to the model or family they have open, start the script with revit\.get_active_document\(\), and call get_api_reference for the built-in primitives before writing raw batches\./);
});
