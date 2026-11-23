// Live installed-build acceptance for the built-in read primitives (spec #9 Phase A, criterion 2's
// execute_script run). Kept outside test/ so node --test does not collect it. Run on the Windows
// seat with the installed Node, from a copy placed in <install>\app\server so the bundled MCP SDK
// resolves, while the fixture from test/revit-primitives.integration.ps1 is Revit's active document:
//   node primitives.live.mjs <mcp.json> <revit-pid> <fixture.rvt>
// The fixture's expectations are read from <fixture.rvt>.json. Every observation prints one JSON
// line; the process exits nonzero if any check fails.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [configPath, pidText, fixture] = process.argv.slice(2);
if (!fixture) throw new Error("Usage: node primitives.live.mjs <mcp.json> <revit-pid> <fixture.rvt>");
const processId = Number(pidText);
const readJson = file => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const entry = readJson(configPath).mcpServers["drive-it"];
const expected = readJson(`${fixture}.json`);
const env = { ...process.env, ...entry.env };
let failures = 0;

function check(name, passed, observed) {
  if (!passed) failures += 1;
  console.log(JSON.stringify({ check: name, passed: Boolean(passed), observed }));
}

// The fixture's folder is the workspace root, as the user would pick it in the Drive-It window.
const root = path.dirname(fixture);
const operator = JSON.parse(execFileSync(entry.command, [path.join(path.dirname(entry.args[0]), "operator.js"), "workspace", "set", root], { env, encoding: "utf8" }));
check("workspace root set", operator.root?.toLowerCase() === root.toLowerCase(), operator.root);

const client = new Client({ name: "drive-it-primitives-acceptance", version: "1" });
await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: "pipe" }));
try {
  const reference = (await client.callTool({ name: "get_api_reference", arguments: {} })).structuredContent;
  const names = reference.entries.map(item => item.name);
  const primitives = ["get_active_document", "find_elements", "get_parameters", "list_types", "list_views", "get_selection", "set_selection"];
  check("api version", reference.version === "revit-2026-alpha.2", reference.version);
  check("reference lists every primitive and units", [...primitives.map(name => `revit.${name}`), "units.to_internal", "units.from_internal"].every(name => names.includes(name)), names);

  // The model the user has open, reached without a document argument or a path.
  const source = `
active = revit.get_active_document()
doc = active["document"]
walls = revit.find_elements(category="Walls")
ids = [wall["id"] for wall in walls["elements"]]
heights = revit.get_parameters(ids, names=["Unconnected Height"], includeType=False)
checks.record("active document is the open fixture", doc["path"].lower() == args["fixture"].lower(), doc["path"])
checks.record("openDocuments lists it as active", any(item["uniqueId"] == doc["uniqueId"] and item["isActive"] for item in doc["openDocuments"]), doc["openDocuments"])
checks.record("find_elements without a document argument returns the fixture's walls", sorted(ids) == sorted(args["walls"]), ids)
result = {
    "title": doc["title"], "path": doc["path"], "uniqueId": doc["uniqueId"], "isModified": doc["isModified"],
    "activeView": doc["activeView"], "walls": ids,
    "heightsMm": [round(units.from_internal(item["parameters"][0]["value"], "mm"), 3) for item in heights],
}`;
  const run = await client.callTool({
    name: "execute_script",
    arguments: {
      processId,
      timeoutMs: 120000,
      displayName: "Read the walls of the open model",
      source,
      arguments: { fixture, walls: expected.walls.map(wall => wall.id) },
    },
  });
  const receipt = run.structuredContent;
  check("execute_script succeeded", !run.isError && receipt?.status === "succeeded", run.isError ? run.content[0].text : { status: receipt.status, error: receipt.error });
  check("every script check passed", receipt?.checks?.length === 3 && receipt.checks.every(item => item.passed), receipt?.checks);
  check("receipt document is the fixture", receipt?.document?.path?.toLowerCase() === fixture.toLowerCase(), receipt?.document);
  const heights = expected.walls.map(wall => Math.round(wall.height * 304.8 * 1000) / 1000).sort();
  check("heights read through units", JSON.stringify([...(receipt?.result?.heightsMm || [])].sort()) === JSON.stringify(heights), receipt?.result?.heightsMm);
  console.log(JSON.stringify({ runId: receipt?.runId, result: receipt?.result }));
} finally {
  await client.close();
}
console.log(JSON.stringify({ failures }));
process.exit(failures ? 1 : 0);
