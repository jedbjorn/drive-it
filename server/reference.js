export const API_VERSION = "revit-2026-alpha.1";

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
  create_3d_view: [withDocument({ name: "Optional: Unique 3D view name; Revit names the view when omitted" }), "createdViews: [{id, name, type}]; pass id to capture_revit_view as viewId", "Creates an isometric 3D view in an RVT or RFA model transaction"],
  create_family_type: [withDocument({ name: "Required: New, unique family type name" }), "Created family type identity", "Creates a family type in an RFA model transaction; parameter values are not changed"],
  delete_element: [withDocument({ elementId: "Required: Element id of an existing element" }), "Deleted element identity", "Deletes an existing element and its dependent elements in the model transaction"],
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
