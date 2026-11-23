export const API_VERSION = "revit-2026-alpha.2";

function withDocument(args) {
  return { ...args, document: "Optional: {path, uniqueId} target; defaults to the selected document" };
}

const revitOperations = {
  open_document: [withDocument({ path: "Required: RVT or RFA model file path", kind: "Optional: rvt or rfa; inferred from the path" }), "Opened document identity", "Opens an existing RVT or RFA document"],
  create_document: [withDocument({ templatePath: "Required: RTE or RFT template path matching kind", kind: "Required: rvt or rfa" }), "Created unsaved document identity", "Creates an unsaved RVT or RFA document from a template; use save_as_document to choose its file path"],
  read_document: [withDocument({}), "Document snapshot", "Reads the selected document without model changes"],
  save_document: [withDocument({}), "Saved document identity", "Saves the selected document to its existing path; unsaved documents require save_as_document"],
  save_as_document: [withDocument({ destinationPath: "Required: Destination RVT or RFA path matching the document kind", overwrite: "Optional: Boolean; replace an existing destination only when true (default false)" }), "Saved document identity; the document handle is retained", "Saves the selected document to destinationPath and retains its identity"],
  close_document: [withDocument({}), "Closed document identity", "Closes the selected document without saving additional changes"],
  delete_document: [withDocument({}), "Deleted file observation", "Closes the selected saved document without saving additional changes, then deletes its current file"],
  create_level: [withDocument({ name: "Required: Level name", elevation: "Required: Finite elevation in Revit internal units" }), "Created element identity", "Creates a level in an RVT model transaction"],
  create_wall: [withDocument({ start: "Required: {x, y, z} finite start point in Revit internal units", end: "Required: {x, y, z} finite, distinct end point in Revit internal units", baseLevelId: "Required: Element id of an existing level", height: "Required: Positive finite wall height in Revit internal units" }), "Created element identity", "Creates a wall in an RVT model transaction"],
  create_3d_view: [withDocument({ name: "Optional: Unique 3D view name; Revit names the view when omitted" }), "createdViews: [{id, name, type}] in the response and the execute_script receipt; pass id to capture_revit_view as viewId", "Creates an isometric 3D view in an RVT or RFA model transaction; families where Revit allows no 3D view, such as annotation families, fail with view_creation_not_allowed"],
  create_family_type: [withDocument({ name: "Required: New, unique family type name" }), "Created family type identity", "Creates a family type in an RFA model transaction; parameter values are not changed"],
  delete_element: [withDocument({ elementId: "Required: Element id of an existing element" }), "Deleted element identity", "Deletes an existing element and its dependent elements in the model transaction"],
};

const elementSummary = "{id, uniqueId, name, category, builtInCategory, typeId, typeName, familyName, familyId, levelId}";
const parameterEntry = "{name, builtIn, guid, storageType, value, display, readOnly, hasValue}; value is raw, doubles in Revit internal units";
const targetsActive = "Later calls in the same script target the returned document unless they pass document";

// Built-in primitives: [arguments, results, effects, example]. Read primitives return their output
// directly; the others return the full broker response like the operations above.
const revitPrimitives = {
  get_active_document: [withDocument({}),
    "Full response; document is the active document's snapshot plus isModified, activeView {id, name, viewType} or null, and openDocuments [{uniqueId, title, path, kind, isActive}] for every open, non-linked document",
    `Resolves the document shown in Revit's window (RVT or RFA) and registers it and every open document. ${targetsActive}. No transaction, no policy paths, no change to the active document or view; fails with no_active_document, listing openDocuments, when none is active`,
    "doc = revit.get_active_document()[\"document\"]"],
  find_elements: [withDocument({
    category: "Required: BuiltInCategory name (\"OST_Walls\") or the category name the document shows (\"Walls\"); unknown names fail with unknown_category and the closest names",
    kind: "Optional: \"instance\" (default) or \"type\"",
    levelId: "Optional: Level element id; instances whose level matches (not with kind \"type\")",
    typeName: "Optional: Exact type name",
    limit: "Optional: Page size, default 200, maximum 2000; more fails with limit_exceeded",
    offset: "Optional: Elements to skip, default 0",
  }),
  `Returns the result directly: {total, returned, offset, truncated, elements: [${elementSummary}]} in element-id order; a field is null when it does not apply, and familyId is the loadable family's id`,
  "Reads one page of elements of a category; no transaction, the model is unchanged",
  "walls = revit.find_elements(category=\"Walls\")"],
  get_parameters: [withDocument({
    elementIds: "Required: List of element ids, at most 2000",
    names: "Optional: List of exact parameter names to return",
    includeType: "Optional: Boolean; also read each element's type parameters (default true)",
  }),
  `Returns the result directly: [{id, uniqueId, typeId, parameters: [${parameterEntry}], type: {id, parameters} or null}]`,
  "Reads parameters of elements and their types; a missing id fails the whole call with element_not_found naming each one; no transaction, the model is unchanged",
  "params = revit.get_parameters(elementIds=[123], names=[\"Comments\"])"],
  list_types: [withDocument({ category: "Required: Category, resolved as in find_elements" }),
    "Returns the result directly: [{id, uniqueId, name, familyName, familyId, category}] sorted by family then name",
    "Lists the types of one category; no transaction, the model is unchanged",
    "wall_types = revit.list_types(category=\"Walls\")"],
  list_views: [withDocument({
    viewTypes: "Optional: List of Revit ViewType names, such as [\"FloorPlan\", \"ThreeD\"]; default every type",
    includeSheets: "Optional: Boolean; include sheets (default true)",
    includeTemplates: "Optional: Boolean; include view templates (default false)",
  }),
  "Returns the result directly: [{id, uniqueId, name, viewType, isTemplate, sheetNumber, levelId, capturable}]; capturable views can be passed to capture_revit_view as viewId",
  "Lists views and sheets; no transaction, the model is unchanged",
  "views = revit.list_views(viewTypes=[\"ThreeD\"])"],
  get_selection: [withDocument({}),
    "Returns the result directly: [{id, uniqueId, name, category, typeName}] for the elements the user has selected; [] when nothing is selected",
    "Reads the live UI selection of the active document; another document fails with document_not_active",
    "selected = revit.get_selection()"],
  set_selection: [withDocument({ elementIds: "Required: List of element ids, at most 2000; [] clears the selection" }),
    "Full response with a changes line and a selection_readback check comparing the request with Revit's selection",
    "Replaces the active document's UI selection. No transaction, no document change, no undo entry, no zoom or view change; document_not_active or element_not_found leave the selection unchanged",
    "revit.set_selection(elementIds=[123])"],
};

const unitsOperations = {
  to_internal: "Converts a value in unit to Revit internal units",
  from_internal: "Converts a value in Revit internal units to unit",
};

function exampleValue(key, operation) {
  if (operation === "create_family_type" && key === "name") return '"Type 1"';
  const values = {
    path: '"C:\\\\DriveIt\\\\model.rvt"',
    destinationPath: '"C:\\\\DriveIt\\\\model.rvt"',
    templatePath: '"C:\\\\DriveIt\\\\template.rte"',
    kind: '"rvt"',
    name: '"L2"',
    elevation: "4.0",
    start: '{"x": 0, "y": 0, "z": 0}',
    end: '{"x": 3, "y": 0, "z": 0}',
    baseLevelId: "123",
    height: "3.0",
    overwrite: "True",
    elementId: "123",
    encoding: '"utf-8"',
    content: '"text"',
    source: '"C:\\\\DriveIt\\\\source.txt"',
    destination: '"C:\\\\DriveIt\\\\destination.txt"',
  };
  return values[key];
}

function exampleFor(name, args) {
  const required = Object.entries(args).filter(([, description]) => description.startsWith("Required:"));
  return `result = revit.${name}(${required.map(([key]) => `${key}=${exampleValue(key, name)}`).join(", ")})`;
}

const fileOperations = {
  read: [{ path: "Required: File to read", encoding: "Optional: Text encoding; default utf-8" }, "File contents", "Reads one file"],
  write: [{ path: "Required: File to create or overwrite", content: "Required: Text content", encoding: "Optional: Text encoding; default utf-8" }, "Written path", "Creates or overwrites one file"],
  rename: [{ source: "Required: Existing path", destination: "Required: Destination path" }, "Destination path", "Renames a file or directory"],
  move: [{ source: "Required: Existing path", destination: "Required: Destination path" }, "Destination path", "Moves a file or directory"],
  delete: [{ path: "Required: File or empty directory to remove" }, "Deleted path", "Deletes a file or empty directory"],
};

export function apiReference(name) {
  const entries = [];
  for (const [operation, [args, results, effects]] of Object.entries(revitOperations)) {
    entries.push({
      name: `revit.${operation}`,
      apiVersion: API_VERSION,
      arguments: args,
      results,
      effects,
      example: exampleFor(operation, args),
    });
  }
  for (const [operation, [args, results, effects, example]] of Object.entries(revitPrimitives)) {
    entries.push({ name: `revit.${operation}`, apiVersion: API_VERSION, arguments: args, results, effects, example });
  }
  for (const [operation, effects] of Object.entries(unitsOperations)) {
    entries.push({
      name: `units.${operation}`,
      apiVersion: API_VERSION,
      arguments: {
        value: "Required: Number",
        unit: "Required: mm, cm, m, in or ft (length); mm2, m2, in2 or ft2 (area); deg or rad (angle)",
      },
      results: "Number; Revit internal units are feet, square feet and radians; an unknown unit raises ValueError listing the valid units",
      effects: `${effects}; pure Python, no Revit call`,
      example: operation === "to_internal" ? "height = units.to_internal(3000, \"mm\")" : "height_mm = units.from_internal(10.0, \"mm\")",
    });
  }
  for (const [operation, [args, results, effects]] of Object.entries(fileOperations)) {
    entries.push({
      name: `files.${operation}`,
      apiVersion: API_VERSION,
      arguments: args,
      results,
      effects,
      example: `result = files.${operation}(${Object.keys(args).map(key => `${key}=${exampleValue(key)}`).join(", ")})`,
    });
  }
  entries.push({
    name: "revit.execute",
    apiVersion: API_VERSION,
    arguments: { operations: "Required: Ordered [{type, arguments}] batch", document: "Optional: {path, uniqueId} target; defaults to the selected document" },
    results: "Broker response with observed changes, files, elements, and checks",
    effects: "Applies a typed model batch; model-only batches share one transaction",
    example: "result = revit.execute([{\"type\": \"create_level\", \"arguments\": {\"name\": \"L2\", \"elevation\": 4.0}}])",
  });
  entries.push({
    name: "checks.record",
    apiVersion: API_VERSION,
    arguments: { name: "Required: Check name", passed: "Required: Boolean observed result", observed: "Optional: Observed value" },
    results: "The passed boolean",
    effects: "Adds an explicit observed check to the run receipt",
    example: "checks.record(\"level exists\", result is not None)",
  });
  return name ? entries.filter(entry => entry.name === name) : entries;
}
