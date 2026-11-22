export const API_VERSION = "revit-2026-alpha.1";

const revitOperations = {
  open_document: [{ path: "Model file path" }, "Opened document identity", "Opens an RVT or RFA document"],
  create_document: [{ path: "Destination model path", kind: "rvt or rfa", templatePath: "Optional template path" }, "Created document identity", "Creates a model document"],
  read_document: [{}, "Document snapshot", "Reads the selected document without model changes"],
  save_document: [{}, "Saved document identity", "Saves the selected document"],
  save_as_document: [{ path: "Destination model path" }, "Saved document identity; the document handle is retained", "Saves the selected document to a new path"],
  close_document: [{}, "Closed document identity", "Closes the selected document"],
  delete_document: [{ path: "Optional path when it differs from the selected document" }, "Deleted file observation", "Deletes a disposable model file"],
  create_level: [{ name: "Level name", elevation: "Elevation in Revit internal units" }, "Created element identity", "Creates a level in the model transaction"],
  create_wall: [{ start: "[x, y, z]", end: "[x, y, z]", levelId: "Optional level element id", height: "Optional wall height" }, "Created element identity", "Creates a wall in the model transaction"],
  create_family_type: [{ typeName: "New family type name", parameters: "Optional parameter values" }, "Created family type identity", "Creates a family type in an RFA document"],
  delete_element: [{ elementId: "Revit element id" }, "Deleted element identity", "Deletes an element in the model transaction"],
};

function exampleValue(key) {
  const values = {
    path: '"C:\\\\DriveIt\\\\model.rvt"',
    templatePath: '"C:\\\\DriveIt\\\\template.rte"',
    kind: '"rvt"',
    name: '"L2"',
    typeName: '"Type 1"',
    elevation: "4.0",
    start: "[0, 0, 0]",
    end: "[3, 0, 0]",
    levelId: "123",
    height: "3.0",
    parameters: "{}",
    elementId: "123",
    encoding: '"utf-8"',
    content: '"text"',
    source: '"C:\\\\DriveIt\\\\source.txt"',
    destination: '"C:\\\\DriveIt\\\\destination.txt"',
  };
  return values[key];
}

function exampleFor(name, args) {
  return `result = revit.${name}(${Object.keys(args).map(key => `${key}=${exampleValue(key)}`).join(", ")})`;
}

const fileOperations = {
  read: [{ path: "File to read", encoding: "Text encoding; default utf-8" }, "File contents", "Reads one file"],
  write: [{ path: "File to create or overwrite", content: "Text content", encoding: "Text encoding; default utf-8" }, "Written path", "Creates or overwrites one file"],
  rename: [{ source: "Existing path", destination: "Destination path" }, "Destination path", "Renames a file or directory"],
  move: [{ source: "Existing path", destination: "Destination path" }, "Destination path", "Moves a file or directory"],
  delete: [{ path: "File or empty directory to remove" }, "Deleted path", "Deletes a file or empty directory"],
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
    arguments: { operations: "Ordered [{type, arguments}] batch", document: "Optional {path, uniqueId} target" },
    results: "Broker response with observed changes, files, elements, and checks",
    effects: "Applies a typed model batch; model-only batches share one transaction",
    example: "result = revit.execute([{\"type\": \"create_level\", \"arguments\": {\"name\": \"L2\", \"elevation\": 4.0}}])",
  });
  entries.push({
    name: "checks.record",
    apiVersion: API_VERSION,
    arguments: { name: "Check name", passed: "Boolean observed result", observed: "Optional observed value" },
    results: "The passed boolean",
    effects: "Adds an explicit observed check to the run receipt",
    example: "checks.record(\"level exists\", result is not None)",
  });
  return name ? entries.filter(entry => entry.name === name) : entries;
}
