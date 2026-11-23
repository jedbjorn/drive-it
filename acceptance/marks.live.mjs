// Live installed-build acceptance for element marks (Feature #6 spec #8). Kept outside test/ so
// node --test does not collect it. Run on the Windows seat with the installed Node, from a copy
// placed in <install>\app\server so the bundled MCP SDK resolves:
//   node marks.live.mjs <mcp.json> <revit-pid> <out-dir> <views.json>
// views.json names open documents and view ids:
//   { "kinds": [{ "label", "path", "viewId", "kind" }], "snowdon": { "path", "plan", "elevation",
//     "section", "threeD", "cutaway", "perspective", "unmarkedId" }, "fixture": { "path",
//     "perspective", "referencePlane" } }
// Every observation prints one JSON line; marked images and legends are copied to <out-dir>; the
// process exits nonzero if any check fails.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [configPath, pidText, outDir, viewsPath] = process.argv.slice(2);
if (!viewsPath) throw new Error("Usage: node marks.live.mjs <mcp.json> <revit-pid> <out-dir> <views.json>");
const processId = Number(pidText);
const views = JSON.parse(readFileSync(viewsPath, "utf8").replace(/^﻿/, ""));
const entry = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, "")).mcpServers["drive-it"];
const launchRoot = path.join(outDir, "launch");
const env = { ...process.env, ...entry.env, DRIVE_IT_LAUNCH_ROOT: launchRoot, DRIVE_IT_REFERENCE_RETENTION: "keep" };
mkdirSync(outDir, { recursive: true });
let failures = 0;

function check(name, passed, observed) {
  if (!passed) failures += 1;
  console.log(JSON.stringify({ check: name, passed: Boolean(passed), observed }));
  return passed;
}

const client = new Client({ name: "drive-it-marks-acceptance", version: "1" });
await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: "pipe" }));

const PLAN = new Set(["FloorPlan", "CeilingPlan", "EngineeringPlan"]);
function sessionFiles() {
  const references = path.join(launchRoot, "_reference-images");
  try {
    return readdirSync(references).flatMap(session => readdirSync(path.join(references, session)).map(name => `${session}/${name}`)).sort();
  } catch {
    return [];
  }
}

async function capture(label, document, viewId, extra = {}) {
  const started = Date.now();
  const result = await client.callTool({
    name: "capture_revit_view",
    arguments: { processId, document: { path: document }, viewId: String(viewId), purpose: `Marks acceptance: ${label}`, ...extra },
  });
  const ms = Date.now() - started;
  if (result.isError) return { label, ms, error: result.content[0].text, images: result.content.filter(block => block.type === "image").length };
  const value = result.structuredContent;
  const saved = readFileSync(value.absolutePath);
  const returned = Buffer.from(result.content.find(block => block.type === "image").data, "base64");
  const sidecar = JSON.parse(readFileSync(path.join(launchRoot, value.sidecarPath), "utf8"));
  copyFileSync(value.absolutePath, path.join(outDir, `${label}.png`));
  writeFileSync(path.join(outDir, `${label}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return { label, ms, value, sameBytes: saved.equals(returned), sidecar };
}

function legendWellFormed(marks, width, height) {
  return marks.legend.every((row, index) => row.mark === index + 1 && /^[1-9][0-9]*$/.test(row.elementId)
    && ["category", "familyName", "typeName", "bounds"].every(key => key in row)
    && row.x >= 0 && row.x < width && row.y >= 0 && row.y < height
    && (row.bounds === null || (row.x >= row.bounds.x && row.x <= row.bounds.x + row.bounds.width
      && row.y >= row.bounds.y && row.y <= row.bounds.y + row.bounds.height)));
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  // --- Guidance is present and brief; the visual QA rule is intact ---
  const { tools } = await client.listTools();
  const tool = tools.find(candidate => candidate.name === "capture_revit_view");
  const instructions = client.getInstructions() ?? "";
  for (const [name, text] of [["description", tool.description], ["instructions", instructions]]) {
    check(`guidance in ${name}`, ["Element marks are optional", "next step needs an element id", "clean visual check",
      "marks.legend", "pixel bounds", "no mark does not mean no element", "markElementIds", "carry the elementId forward",
      "Perspective 3D views do not support marks", "Receipts and structured checks remain the authority"].every(part => text.includes(part)),
    text.length);
    check(`visual QA rule intact in ${name}`, text.includes("After each modeling round") && text.includes("never claim a visual pass you did not see"), null);
  }
  check("marks arguments listed", tool.inputSchema.properties.marks?.type === "boolean" && tool.inputSchema.properties.markElementIds?.type === "array",
    Object.keys(tool.inputSchema.properties));

  // --- Captures without marks are unchanged ---
  const { snowdon, fixture } = views;
  const plain = await capture("snowdon-plan-unmarked", snowdon.path, snowdon.plan);
  check("unmarked capture has no marks object", !plain.error && plain.value.marks === undefined && plain.sidecar.marks === undefined, plain.error);
  check("unmarked capture returns the saved bytes", plain.sameBytes, plain.value?.image);

  // --- Each view kind that supports marks ---
  for (const view of views.kinds) {
    const unmarked = await capture(`${view.label}-unmarked`, view.path, view.viewId);
    const shot = await capture(`${view.label}-marked`, view.path, view.viewId, { marks: true });
    if (!check(`${view.label}: marked capture succeeds`, !shot.error && !unmarked.error, shot.error ?? unmarked.error)) continue;
    const { marks, image, export: exported, view: target } = shot.value;
    check(`${view.label}: same bytes returned and saved`, shot.sameBytes, image.sha256);
    check(`${view.label}: sidecar carries the marks`, JSON.stringify(shot.sidecar.marks) === JSON.stringify(marks), null);
    check(`${view.label}: same size as unmarked`, image.width === unmarked.value.image.width && image.height === unmarked.value.image.height,
      [image.width, image.height, unmarked.value.image.width, unmarked.value.image.height]);
    check(`${view.label}: legend well formed`, legendWellFormed(marks, image.width, image.height), marks.legend.length);
    const expectedNotes = 1 + (PLAN.has(target.type) ? 1 : 0) + (target.type === "ThreeD" ? 1 : 0);
    check(`${view.label}: notes for ${target.type}`, marks.notes.length === expectedNotes && marks.notMarked === undefined, marks.notes);
    check(`${view.label}: model unchanged`, exported.documentModifiedBefore === exported.documentModifiedAfter && !exported.transactionStarted && !exported.temporaryViewCreated, exported);
  }

  // --- Snowdon: plan, elevation, the transverse section, the default 3D view ---
  for (const [label, viewId] of [["snowdon-plan", snowdon.plan], ["snowdon-elevation", snowdon.elevation], ["snowdon-transverse", snowdon.section], ["snowdon-default-3d", snowdon.threeD]]) {
    const shot = await capture(`${label}-marked`, snowdon.path, viewId, { marks: true });
    if (!check(`${label}: marked`, !shot.error, shot.error)) continue;
    check(`${label}: legend well formed`, legendWellFormed(shot.value.marks, shot.value.image.width, shot.value.image.height),
      { marks: shot.value.marks.legend.length, omitted: shot.value.marks.omitted, ms: shot.ms });
    if (label === "snowdon-transverse") {
      check(`${label}: element ${snowdon.unmarkedId} has no mark`, !shot.value.marks.legend.some(row => row.elementId === snowdon.unmarkedId), null);
    }
  }
  const asked = await capture("snowdon-transverse-requested", snowdon.path, snowdon.section, { markElementIds: [snowdon.unmarkedId] });
  check(`element ${snowdon.unmarkedId} requested: not_visible`, asked.value?.marks.notMarked?.[0]?.reason === "not_visible", asked.value?.marks ?? asked.error);

  // --- Failures are explicit and leave no artifact ---
  const before = sessionFiles();
  for (const [label, document, viewId, extra, pattern] of [
    ["perspective", snowdon.path, snowdon.perspective, { marks: true }, /^MARKS_UNAVAILABLE: /],
    ["fixture perspective", fixture.path, fixture.perspective, { marks: true }, /^MARKS_UNAVAILABLE: /],
    ["malformed id", snowdon.path, snowdon.plan, { markElementIds: ["12a"] }, /^INVALID_ELEMENT_ID: /],
  ]) {
    const failed = await capture(`failure-${label.replace(/ /g, "-")}`, document, viewId, extra);
    check(`failure ${label}`, failed.error && pattern.test(failed.error) && failed.images === 0, failed.error);
  }
  check("failures left no artifact", JSON.stringify(sessionFiles()) === JSON.stringify(before), sessionFiles().length - before.length);
  const reasons = await capture("fixture-reasons", fixture.path, fixture.iso, { markElementIds: ["999999999", fixture.referencePlane] });
  const rows = Object.fromEntries((reasons.value?.marks.notMarked ?? []).map(row => [row.elementId, row.reason]));
  check("unknown id is not_found, reference plane is not_markable", rows["999999999"] === "not_found" && rows[fixture.referencePlane] === "not_markable", rows);
  const big = await capture("largest-marked", snowdon.path, snowdon.shaded ?? snowdon.threeD, { marks: true, pixelSize: 2048 });
  console.log(JSON.stringify({ observation: "largest marked capture at 2048 px", bytes: big.value?.image.byteSize ?? null, error: big.error ?? null }));

  // --- Cost: added time at about 500 elements, median of 3 at 1024 px ---
  for (const [label, viewId] of [["plan", snowdon.plan], ["transverse", snowdon.section], ["cutaway", snowdon.cutaway]]) {
    const plainMs = [];
    const markedMs = [];
    for (let run = 0; run < 3; run += 1) {
      plainMs.push((await capture(`cost-${label}-plain-${run}`, snowdon.path, viewId)).ms);
      markedMs.push((await capture(`cost-${label}-marked-${run}`, snowdon.path, viewId, { marks: true })).ms);
    }
    const added = median(markedMs) - median(plainMs);
    check(`cost ${label}: added under 2 s`, added < 2000, { plainMs, markedMs, addedMs: added });
  }
} finally {
  await client.close();
}
console.log(JSON.stringify({ summary: failures === 0 ? "passed" : "failed", failures }));
process.exitCode = failures === 0 ? 0 : 1;
