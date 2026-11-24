// Live installed-alpha acceptance for the Unguided runtime (spec #3), script library (spec #4), and
// the promotion of a checked set_parameters script (spec #9 criterion 5).
// Kept outside test/ so node --test does not collect it. Run on the Windows seat with the installed
// Node, from a copy placed in <install>\app\server so the bundled MCP SDK resolves:
//   node live.mjs <mcp.json> <revit-pid> <rootA> <rootB> <project.rte> <family.rft> <outside-file>
// Every observation prints one JSON line; the process exits nonzero if any check fails.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [configPath, pidText, rootA, rootB, projectTemplate, familyTemplate, outsideFile] = process.argv.slice(2);
if (!outsideFile) throw new Error("Usage: node acceptance.live.mjs <mcp.json> <pid> <rootA> <rootB> <project.rte> <family.rft> <outside-file>");
const processId = Number(pidText);
const entry = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")).mcpServers["drive-it"];
const env = { ...process.env, ...entry.env };
const operatorScript = path.join(path.dirname(entry.args[0]), "operator.js");
const stamp = Date.now().toString(36);
let failures = 0;

function check(name, passed, observed) {
  if (!passed) failures += 1;
  console.log(JSON.stringify({ check: name, passed: Boolean(passed), observed }));
  return passed;
}

function operator(...args) {
  return JSON.parse(execFileSync(entry.command, [operatorScript, ...args], { env, encoding: "utf8" }));
}

async function connect() {
  const client = new Client({ name: "drive-it-live-acceptance", version: "1" });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: "pipe" }));
  await client.listTools();
  return client;
}

let client = await connect();
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { error: result.isError ? result.content[0].text : null, value: result.structuredContent };
}
async function run(args) {
  return call("execute_script", { processId, timeoutMs: 120000, displayName: "Live acceptance run", ...args });
}
const code = text => (text || "").split(":")[0];

// Python helpers run inline to observe documents independently of the script under test.
const READ_MODEL = `
snap = revit.open_document(path=args["path"])["document"]
result = {"levels": [l["name"] for l in snap.get("levels", [])], "familyTypes": snap.get("familyTypes", [])}
revit.close_document()
checks.record("reopened", True, result)`;

try {
  // --- Discovery, session, reference (spec #3) ---
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  check("tools discoverable", ["get_revit_session", "execute_script", "save_script", "search_scripts", "get_script", "promote_script", "retire_script", "get_api_reference"].every(name => names.includes(name)), names);
  check("get_guidance absent", !names.includes("get_guidance"), names);
  const session = await call("get_revit_session", { processId });
  // Revit 2026 or 2027 (spec #22 R3/R4): the version is the session's own.
  check("live Revit session", !session.error && ["2026", "2027"].includes(session.value.version), session.value || session.error);
  const reference = await call("get_api_reference", {});
  check("api reference local", reference.value?.entries?.length > 10, reference.value?.entries?.length);

  // --- Root A fixtures ---
  check("root A selected", operator("workspace", "set", rootA).root.toLowerCase() === rootA.toLowerCase(), rootA);
  const rvt = path.join(rootA, `fixture-${stamp}.rvt`);
  const rfa = path.join(rootA, `fixture-${stamp}.rfa`);
  const fixtures = await run({
    source: `
revit.create_document(templatePath=args["rte"], kind="rvt")
revit.save_as_document(destinationPath=args["rvt"])
revit.close_document()
revit.create_document(templatePath=args["rft"], kind="rfa")
revit.save_as_document(destinationPath=args["rfa"])
revit.close_document()
checks.record("fixtures saved", True)`,
    arguments: { rte: projectTemplate, rft: familyTemplate, rvt, rfa },
  });
  check("receipt keeps the run display name", fixtures.value?.displayName === "Live acceptance run", fixtures.value?.displayName);
  check("disposable RVT/RFA fixtures created", fixtures.value?.status === "succeeded" && existsSync(rvt) && existsSync(rfa), fixtures.value?.error || fixtures.error);
  check("fixture run needed no decision", fixtures.value?.policyDecisionIds.length === 0, fixtures.value?.policyDecisionIds);

  // --- Save drafts ---
  const levelSource = `
revit.open_document(path=args["model"])
revit.create_level(name=args["name"], elevation=args["elevation"])
revit.save_document()
snap = revit.read_document()["document"]
names = [l["name"] for l in snap["levels"]]
checks.record("level present after save", args["name"] in names, names)
revit.close_document()
result = {"levels": names}`;
  const levelSchema = { type: "object", properties: { model: { type: "string" }, name: { type: "string" }, elevation: { type: "number", default: 12 } }, required: ["model", "name"], additionalProperties: false };
  const savedLevel = await call("save_script", { name: `Add level ${stamp}`, purpose: "Add one named level and save", domain: "levels", documentKind: "rvt", inputSchema: levelSchema, source: levelSource, capabilities: ["revit.create_level", "revit.save_document"], expectedEffects: ["one new level", "model saved"], idempotencyKey: `level-${stamp}` });
  const levelId = savedLevel.value?.script.scriptId;
  check("RVT draft saved", savedLevel.value?.created && savedLevel.value.script.state === "draft", savedLevel.value || savedLevel.error);
  const retrySave = await call("save_script", { name: `Add level ${stamp}`, documentKind: "rvt", inputSchema: levelSchema, source: levelSource, idempotencyKey: `level-${stamp}` });
  check("idempotent save returns existing revision", retrySave.value?.created === false && retrySave.value.script.revision === 1, retrySave.value);

  const typeSource = `
revit.open_document(path=args["family"])
revit.create_family_type(name=args["typeName"])
revit.save_document()
types = revit.read_document()["document"]["familyTypes"]
checks.record("family type present after save", args["typeName"] in types, types)
revit.close_document()
result = {"familyTypes": types}`;
  const savedType = await call("save_script", { name: `Add family type ${stamp}`, purpose: "Add one family type and save", domain: "families", documentKind: "rfa", inputSchema: { type: "object", properties: { family: { type: "string" }, typeName: { type: "string" } }, required: ["family", "typeName"] }, source: typeSource });
  const typeId = savedType.value?.script.scriptId;
  check("RFA draft saved", savedType.value?.created, savedType.value || savedType.error);

  const hidden = await call("search_scripts", { query: stamp });
  check("default search hides drafts", hidden.value?.scripts.length === 0, hidden.value);
  const drafts = await call("search_scripts", { query: stamp, includeDrafts: true });
  check("explicit search finds drafts", drafts.value?.scripts.length === 2, drafts.value?.scripts.map(row => row.scriptId));

  // --- Restart: a fresh server process sees the same library ---
  await client.close();
  client = await connect();
  const afterRestart = await call("get_script", { scriptId: levelId, revision: 1 });
  check("draft survives server restart with exact source", afterRestart.value?.source === levelSource, afterRestart.value?.codeHash);

  // --- Execute exact drafts ---
  const level1 = `DI-${stamp}-1`;
  const rvtRun = await run({ script: { scriptId: levelId, revision: 1 }, arguments: { model: rvt, name: level1 }, document: { path: rvt } });
  check("RVT draft executes", rvtRun.value?.status === "succeeded", rvtRun.value?.error || rvtRun.error);
  check("schema default applied", rvtRun.value?.arguments.elevation === 12, rvtRun.value?.arguments);
  const rvtObserved = await run({ source: READ_MODEL, arguments: { path: rvt } });
  check("reopened RVT shows the level", rvtObserved.value?.result?.levels.includes(level1), rvtObserved.value?.result);

  const typeName = `DI-${stamp}-T`;
  const rfaRun = await run({ script: { scriptId: typeId, revision: 1 }, arguments: { family: rfa, typeName }, document: { path: rfa } });
  check("RFA draft executes", rfaRun.value?.status === "succeeded", rfaRun.value?.error || rfaRun.error);
  const rfaObserved = await run({ source: READ_MODEL, arguments: { path: rfa } });
  check("reopened RFA shows the family type", rfaObserved.value?.result?.familyTypes.includes(typeName), rfaObserved.value?.result);

  const invalid = await run({ script: { scriptId: levelId, revision: 1 }, arguments: { model: rvt, name: 7 } });
  check("invalid arguments rejected", code(invalid.error) === "INVALID_ARGUMENTS", invalid.error);
  const ambiguous = await run({ source: "result = 1", script: { scriptId: levelId, revision: 1 } });
  check("ambiguous reference rejected", code(ambiguous.error) === "AMBIGUOUS_SCRIPT", ambiguous.error);
  const unknown = await run({ script: { scriptId: levelId, revision: 99 }, arguments: { model: rvt, name: "never" } });
  check("unknown revision rejected", code(unknown.error) === "SCRIPT_NOT_FOUND", unknown.error);
  const noActive = await run({ script: { scriptId: levelId, revision: "latest" }, arguments: { model: rvt, name: "never" } });
  check("latest needs an active revision", code(noActive.error) === "NO_ACTIVE_REVISION", noActive.error);
  const unchanged = await run({ source: READ_MODEL, arguments: { path: rvt } });
  check("rejected references changed nothing", !unchanged.value?.result?.levels.includes("never") && unchanged.value?.result?.levels.length === rvtObserved.value?.result?.levels.length, unchanged.value?.result);

  // --- Promotion evidence contract ---
  const broken = await call("save_script", { scriptId: levelId, source: `${levelSource}\nraise RuntimeError("broken revision")` });
  const brokenRun = await run({ script: { scriptId: levelId, revision: 2 }, arguments: { model: rvt, name: `DI-${stamp}-2` } });
  check("broken revision fails", ["failed", "partially_applied"].includes(brokenRun.value?.status), brokenRun.value?.status);
  const rejectFailed = await call("promote_script", { scriptId: levelId, revision: 2, runId: brokenRun.value.runId });
  check("failed run cannot promote", rejectFailed.value?.status === "rejected" && rejectFailed.value.unmet.some(row => row.condition === "succeeded"), rejectFailed.value?.unmet);
  const rejectHash = await call("promote_script", { scriptId: levelId, revision: 2, runId: rvtRun.value.runId });
  check("wrong-hash run cannot promote", rejectHash.value?.unmet.some(row => row.condition === "same_code_hash"), rejectHash.value?.unmet);
  const rejectKind = await call("promote_script", { scriptId: typeId, revision: 1, runId: rvtRun.value.runId });
  check("other script/kind run cannot promote", rejectKind.value?.unmet.some(row => row.condition === "document_kind"), rejectKind.value?.unmet);
  check("rejections left drafts", (await call("get_script", { scriptId: levelId, revision: 2 })).value?.state === "draft", broken.value?.script);

  const promoted = await call("promote_script", { scriptId: levelId, revision: 1, runId: rvtRun.value.runId });
  check("checked RVT run promotes without approval", promoted.value?.status === "promoted" && promoted.value.script.state === "active", promoted.value || promoted.error);
  const promotedType = await call("promote_script", { scriptId: typeId, revision: 1, runId: rfaRun.value.runId });
  check("checked RFA run promotes", promotedType.value?.status === "promoted", promotedType.value?.unmet);
  const active = await call("search_scripts", { query: stamp });
  check("default search shows active revisions", active.value?.scripts.length === 2, active.value?.scripts.map(row => `${row.scriptId}@${row.revision}`));

  const level3 = `DI-${stamp}-3`;
  const latestRun = await run({ script: { scriptId: levelId, revision: "latest" }, arguments: { model: rvt, name: level3 }, idempotencyKey: `latest-${stamp}` });
  check("latest resolves the active revision, not the newer draft", latestRun.value?.savedScript.revision === 1, latestRun.value?.savedScript);
  const replay = await run({ script: { scriptId: levelId, revision: "latest" }, arguments: { model: rvt, name: level3 }, idempotencyKey: `latest-${stamp}` });
  check("replay returns the original receipt", replay.value?.runId === latestRun.value?.runId, replay.value?.runId);
  const afterReplay = await run({ source: READ_MODEL, arguments: { path: rvt } });
  check("replay did not duplicate the write", afterReplay.value?.result?.levels.filter(name => name === level3).length === 1, afterReplay.value?.result);

  // --- A checked set_parameters script promotes (spec #9 criterion 5) ---
  const parameterSource = `
revit.open_document(path=args["model"])
info = revit.find_elements(category="OST_ProjectInformation")["elements"][0]
changed = revit.set_parameters([{"elementId": info["id"], "builtIn": "PROJECT_NAME", "value": args["projectName"]}])
stored = revit.get_parameters([info["id"]], names=["Project Name"], includeType=False)[0]["parameters"][0]["value"]
checks.record("project name reads back", stored == args["projectName"], stored)
revit.save_document()
revit.close_document()
result = {"projectName": stored, "changes": changed["changes"]}`;
  const savedParameters = await call("save_script", { name: `Set project name ${stamp}`, purpose: "Set the project name and save", domain: "parameters", documentKind: "rvt", inputSchema: { type: "object", properties: { model: { type: "string" }, projectName: { type: "string" } }, required: ["model", "projectName"] }, source: parameterSource, capabilities: ["revit.set_parameters", "revit.save_document"], expectedEffects: ["project name changed", "model saved"] });
  const parametersId = savedParameters.value?.script.scriptId;
  check("set_parameters draft saved", savedParameters.value?.created, savedParameters.value || savedParameters.error);
  const projectName = `DI-${stamp}-P`;
  const parametersRun = await run({ script: { scriptId: parametersId, revision: 1 }, arguments: { model: rvt, projectName }, document: { path: rvt } });
  const parameterChecks = parametersRun.value?.checks || [];
  check("set_parameters script executes", parametersRun.value?.status === "succeeded", parametersRun.value?.error || parametersRun.error);
  check("set_parameters run carries a passing parameter_readback and the script check",
    parameterChecks.some(row => row.name === "parameter_readback" && row.passed) && parameterChecks.some(row => row.name === "project name reads back" && row.passed), parameterChecks);
  check("set_parameters receipt names the change", (parametersRun.value?.result?.changes || []).some(line => line.includes("Project Name") && line.includes(projectName)), parametersRun.value?.result?.changes);
  const promotedParameters = await call("promote_script", { scriptId: parametersId, revision: 1, runId: parametersRun.value?.runId });
  check("checked set_parameters run promotes", promotedParameters.value?.status === "promoted" && promotedParameters.value.script.state === "active", promotedParameters.value || promotedParameters.error);
  const reread = await run({ source: `
revit.open_document(path=args["path"])
info = revit.find_elements(category="OST_ProjectInformation")["elements"][0]
result = revit.get_parameters([info["id"]], names=["Project Name"], includeType=False)[0]["parameters"][0]["value"]
revit.close_document()
checks.record("reopened", True, result)`, arguments: { path: rvt } });
  check("reopened RVT keeps the project name", reread.value?.result === projectName, reread.value?.result ?? reread.value?.error);

  // --- Retirement ---
  const retired = await call("retire_script", { scriptId: levelId, revision: 1, reason: "live acceptance" });
  check("active revision retires without approval", retired.value?.script.state === "retired", retired.value || retired.error);
  const retiredDraft = await call("retire_script", { scriptId: levelId, revision: 2 });
  check("draft revision retires", retiredDraft.value?.script.state === "retired", retiredDraft.value || retiredDraft.error);
  const afterRetire = await call("search_scripts", { query: stamp });
  check("retired revisions leave default search", afterRetire.value?.scripts.every(row => row.scriptId !== levelId), afterRetire.value?.scripts);
  const retiredRun = await run({ script: { scriptId: levelId, revision: 1 }, arguments: { model: rvt, name: "never" } });
  check("retired revision rejects execution", code(retiredRun.error) === "SCRIPT_RETIRED", retiredRun.error);
  const retiredLatest = await run({ script: { scriptId: levelId, revision: "latest" }, arguments: { model: rvt, name: "never" } });
  check("retired revision leaves latest", code(retiredLatest.error) === "NO_ACTIVE_REVISION", retiredLatest.error);
  const history = await call("get_script", { scriptId: levelId, revision: 1 });
  check("retired history stays inspectable", history.value?.source === levelSource && history.value.runs.length >= 2 && history.value.promotionRunId === rvtRun.value.runId, history.value?.runs?.map(row => row.runId));
  check("library files kept", existsSync(path.join(rootA, ".drive-it", "scripts", levelId, "1.json")), levelId);

  // --- Root B: separate library, cross-root promotion refused ---
  check("root B selected", operator("workspace", "set", rootB).root.toLowerCase() === rootB.toLowerCase(), rootB);
  await client.close();
  client = await connect();
  const missing = await call("search_scripts", {});
  check("root B has no library yet", code(missing.error) === "LIBRARY_NOT_FOUND" || missing.value?.scripts.length === 0, missing.error || missing.value);
  const savedB = await call("save_script", { name: `Add family type ${stamp}`, documentKind: "rfa", inputSchema: { type: "object" }, source: typeSource });
  const crossRoot = await call("promote_script", { scriptId: savedB.value.script.scriptId, revision: 1, runId: rfaRun.value.runId });
  check("cross-root receipt cannot promote", crossRoot.value?.unmet.some(row => row.condition === "same_workspace"), crossRoot.value?.unmet);
  check("root A library untouched", existsSync(path.join(rootA, ".drive-it", "scripts", typeId, "1.json")), typeId);

  // --- Workspace policy in root B (spec #3) ---
  const inRoot = await run({ source: `
files.write(args["a"], "one")
files.write(args["a"], "two")
files.rename(args["a"], args["b"])
files.move(args["b"], args["c"])
result = files.read(args["c"])
files.delete(args["c"])
checks.record("round trip", result == "two", result)`, arguments: { a: path.join(rootB, "a.txt"), b: path.join(rootB, "b.txt"), c: path.join(rootB, "sub-c.txt") } });
  check("in-root create/overwrite/rename/move/delete need no decision", inRoot.value?.status === "succeeded" && inRoot.value.policyDecisionIds.length === 0, inRoot.value?.error || inRoot.value?.policyDecisionIds);
  const before = readFileSync(outsideFile, "utf8");
  const outsideKey = `outside-${stamp}`;
  const outsideArgs = { source: "files.write(args['path'], 'changed')", arguments: { path: outsideFile }, idempotencyKey: outsideKey };
  const pending = await run(outsideArgs);
  check("outside-root write is pending", pending.value?.status === "pending", pending.value?.status);
  const decision = operator("decisions", "list").find(row => row.runId === pending.value.runId && row.status === "pending");
  check("pending request carries the run display name", decision?.displayName === "Live acceptance run", decision?.displayName);
  check("history lists the run by display name", operator("history", "list").find(row => row.runId === pending.value.runId)?.displayName === "Live acceptance run");
  operator("decisions", "deny", decision.id);
  const denied = await run(outsideArgs);
  check("denied outside-root write returns denied", denied.value?.status === "denied", denied.value?.status);
  check("denied target unchanged", readFileSync(outsideFile, "utf8") === before, before);
  const approveKey = `outside-approve-${stamp}`;
  const readArgs = { source: "result = files.read(args['path'])", arguments: { path: outsideFile }, idempotencyKey: approveKey };
  const readPending = await run(readArgs);
  const readDecision = operator("decisions", "list").find(row => row.runId === readPending.value.runId && row.status === "pending");
  operator("decisions", "approve", readDecision.id);
  const approved = await run(readArgs);
  check("approved outside-root read succeeds", approved.value?.status === "succeeded" && approved.value.result === before, approved.value?.status);
  const again = await run({ ...readArgs, idempotencyKey: `${approveKey}-again` });
  check("approval is not reused", again.value?.status === "pending", again.value?.status);

  // --- Self-contained runtime and failure modes (spec #3) ---
  const pip = await run({ source: "import pip" });
  check("package installation refused", pip.value?.status === "failed" && /disabled/.test(pip.value.error?.message), pip.value?.error);
  const timeout = await run({ source: "while True:\n    pass", timeoutMs: 2000 });
  check("timeout is distinct", timeout.value?.status === "timed_out", timeout.value?.status);

  // --- Root persists across restart; switching back restores root A's library ---
  await client.close();
  client = await connect();
  check("root B persisted across restart", operator("workspace", "get").root.toLowerCase() === rootB.toLowerCase(), rootB);
  operator("workspace", "set", rootA);
  const backInA = await call("get_script", { scriptId: typeId, revision: "latest" });
  check("root A library restored with its evidence", backInA.value?.state === "active" && backInA.value.runs.some(row => row.runId === rfaRun.value.runId), backInA.value?.state);
} finally {
  await client.close();
}
console.log(JSON.stringify({ summary: failures === 0 ? "all checks passed" : `${failures} check(s) failed` }));
process.exitCode = failures === 0 ? 0 : 1;
