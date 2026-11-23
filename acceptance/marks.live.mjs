// Live installed-build acceptance for element marks (Feature #6 spec #8). Kept outside test/ so
// node --test does not collect it. Run on the Windows seat with the installed Node, from a copy
// placed in <install>\app\server so the bundled MCP SDK resolves:
//   node marks.live.mjs <mcp.json> <revit-pid> <out-dir> <views.json>
// views.json names open documents and view ids:
//   { "kinds": [{ "label", "path", "viewId", optional "ids": [fixture role ids] }],
//     "snowdon": { "path", "plan", "elevation", "section", "threeD", "cutaway", "perspective",
//       "unmarkedId", optional "shaded" },
//     "fixture": { "path", "perspective", "referencePlane", "iso", "plan", "covered": [ids], "scopeIds": [ids],
//       "symbolPath", "symbolPlan", "symbolFamily", "symbolCategory" } }
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
// Every category the fixtures hold that can be marked: five, the most one call takes.
const FIXTURE_SCOPE = ["OST_Walls", "OST_Floors", "OST_GenericModel", "OST_Levels", "OST_Grids"];
const SNOWDON_FIVE = ["OST_Walls", "OST_Doors", "OST_Windows", "OST_Floors", "OST_Columns"];
const NO_MARK = "Marks are help in finding elements, not a list of what exists or what is visible.";

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
  const text = result.content.find(block => block.type === "text")?.text ?? "";
  copyFileSync(value.absolutePath, path.join(outDir, `${label}.png`));
  writeFileSync(path.join(outDir, `${label}.json`), `${JSON.stringify({ request: extra, ...value }, null, 2)}\n`);
  return { label, ms, value, text, sameBytes: saved.equals(returned), sidecar };
}

function legendWellFormed(marks, width, height) {
  return marks.legend.every((row, index) => row.mark === index + 1 && /^[1-9][0-9]*$/.test(row.elementId)
    && ["category", "familyName", "typeName", "bounds"].every(key => key in row)
    && row.x >= 0 && row.x < width && row.y >= 0 && row.y < height
    && (row.bounds === null || (row.x >= row.bounds.x && row.x <= row.bounds.x + row.bounds.width
      && row.y >= row.bounds.y && row.y <= row.bounds.y + row.bounds.height)));
}

/** Every row is in the scope, no element has two marks, and scope repeats the request. */
function inScope(marks, categories = [], elementIds = []) {
  const ids = marks.legend.map(row => row.elementId);
  return marks.legend.every(row => categories.includes(row.category) || elementIds.includes(row.elementId))
    && new Set(ids).size === ids.length
    && JSON.stringify(marks.scope) === JSON.stringify({ categories: [...new Set(categories)], elementIds: [...new Set(elementIds)] });
}

/** The notes the spec's Result Notes table requires for this view type and scope. */
function expectedNotes(type, categories) {
  let count = 2;
  if (PLAN.has(type)) count += 2;
  if (type === "ThreeD") count += 1 + (categories.some(name => name === "OST_Levels" || name === "OST_Grids") ? 1 : 0);
  return count;
}

const receiptSays = shot => shot.value.marks.notes[0].startsWith(NO_MARK) && shot.text.includes("No mark does not mean no element");
const counts = shot => shot.error ? { error: shot.error } : { marks: shot.value.marks.legend.length, omitted: shot.value.marks.omitted, ms: shot.ms };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  // --- Guidance is present and brief; the visual QA rule is intact ---
  const { tools } = await client.listTools();
  const tool = tools.find(candidate => candidate.name === "capture_revit_view");
  const instructions = client.getInstructions() ?? "";
  for (const [name, text] of [["description", tool.description], ["instructions", instructions]]) {
    check(`guidance in ${name}`, ["Element marks are optional and need a scope", "markCategories", "up to five", "markElementIds",
      "clean visual check", "API names as the legend returns them", "marks.legend", "pixel bounds",
      "Marks are help, not a list of what exists", "does not mean the element is absent or hidden",
      "families drawn only as symbols, often doors and windows, usually get no mark", "carry the elementId forward",
      "Perspective 3D views do not support marks", "Receipts and structured checks remain the authority"].every(part => text.includes(part)),
    text.length);
    check(`visual QA rule intact in ${name}`, text.includes("After each modeling round") && text.includes("never claim a visual pass you did not see"), null);
  }
  check("scope arguments listed, no marks argument", tool.inputSchema.properties.marks === undefined
    && tool.inputSchema.properties.markCategories?.type === "array" && tool.inputSchema.properties.markElementIds?.type === "array",
  Object.keys(tool.inputSchema.properties));

  // --- Captures without a scope are unchanged ---
  const { snowdon, fixture } = views;
  const plain = await capture("snowdon-plan-unmarked", snowdon.path, snowdon.plan);
  check("unmarked capture has no marks object", !plain.error && plain.value.marks === undefined && plain.sidecar.marks === undefined, plain.error);
  check("unmarked capture returns the saved bytes", plain.sameBytes, plain.value?.image);

  // --- Each view kind that supports marks, with the fixture category scope and with an id scope ---
  for (const view of views.kinds) {
    const unmarked = await capture(`${view.label}-unmarked`, view.path, view.viewId);
    const shot = await capture(`${view.label}-categories`, view.path, view.viewId, { markCategories: FIXTURE_SCOPE });
    if (!check(`${view.label}: category-scoped capture succeeds`, !shot.error && !unmarked.error, shot.error ?? unmarked.error)) continue;
    const { marks, image, export: exported, view: target } = shot.value;
    check(`${view.label}: same bytes returned and saved`, shot.sameBytes, image.sha256);
    check(`${view.label}: sidecar carries the marks`, JSON.stringify(shot.sidecar.marks) === JSON.stringify(marks), null);
    check(`${view.label}: same size as unmarked`, image.width === unmarked.value.image.width && image.height === unmarked.value.image.height,
      [image.width, image.height, unmarked.value.image.width, unmarked.value.image.height]);
    check(`${view.label}: legend well formed`, legendWellFormed(marks, image.width, image.height), marks.legend.length);
    check(`${view.label}: legend inside the scope`, inScope(marks, FIXTURE_SCOPE), marks.legend.map(row => row.category));
    check(`${view.label}: notes for ${target.type}`, marks.notes.length === expectedNotes(target.type, FIXTURE_SCOPE)
      && receiptSays(shot) && marks.notMarked === undefined, marks.notes);
    if (target.type === "ThreeD") {
      check(`${view.label}: no level or grid marked in 3D`, !marks.legend.some(row => row.category === "OST_Levels" || row.category === "OST_Grids"), null);
    }
    check(`${view.label}: model unchanged`, exported.documentModifiedBefore === exported.documentModifiedAfter && !exported.transactionStarted && !exported.temporaryViewCreated, exported);
    if (!view.ids) continue;
    const byId = await capture(`${view.label}-ids`, view.path, view.viewId, { markElementIds: view.ids });
    if (!check(`${view.label}: id-scoped capture succeeds`, !byId.error, byId.error)) continue;
    const listed = new Set([...byId.value.marks.legend.map(row => row.elementId), ...byId.value.marks.notMarked.map(row => row.elementId)]);
    check(`${view.label}: every requested id is marked or has a reason`, inScope(byId.value.marks, [], view.ids) && view.ids.every(id => listed.has(id)),
      byId.value.marks.notMarked);
  }

  // --- The scope is honoured: category only, ids only, both; an out-of-scope element still covers ---
  for (const [label, document, viewId, categories, ids] of [
    ["scope-fixture", fixture.path, fixture.iso, ["OST_Floors"], fixture.scopeIds],
    ["scope-snowdon", snowdon.path, snowdon.section, ["OST_Doors"], [snowdon.unmarkedId]],
  ]) {
    const byCategory = await capture(`${label}-categories`, document, viewId, { markCategories: categories });
    const byIds = await capture(`${label}-ids`, document, viewId, { markElementIds: ids });
    const both = await capture(`${label}-both`, document, viewId, { markCategories: categories, markElementIds: ids });
    check(`${label}: category, id and union captures succeed`, !byCategory.error && !byIds.error && !both.error, [byCategory.error, byIds.error, both.error]);
    if (byCategory.error || byIds.error || both.error) continue;
    check(`${label}: each legend is inside its scope`, inScope(byCategory.value.marks, categories) && inScope(byIds.value.marks, [], ids)
      && inScope(both.value.marks, categories, ids), [byCategory, byIds, both].map(counts));
    const union = new Set([...byCategory.value.marks.legend, ...byIds.value.marks.legend].map(row => row.elementId));
    check(`${label}: the union marks what either scope marks`, both.value.marks.legend.every(row => union.has(row.elementId)),
      { union: union.size, both: both.value.marks.legend.length });
  }
  const covered = await capture("scope-covered", fixture.path, fixture.iso, { markElementIds: fixture.covered });
  check("covered elements stay unmarked when what covers them is outside the scope",
    !covered.error && covered.value.marks.legend.length === 0 && covered.value.marks.notMarked.every(row => row.reason === "not_visible"),
  covered.value?.marks ?? covered.error);

  // --- No mark on blank image: Snowdon views with at least two category scopes each ---
  for (const [label, viewId] of [["snowdon-plan", snowdon.plan], ["snowdon-elevation", snowdon.elevation], ["snowdon-transverse", snowdon.section], ["snowdon-default-3d", snowdon.threeD]]) {
    for (const [scopeLabel, categories] of [["walls", ["OST_Walls"]], ["doors-windows", ["OST_Doors", "OST_Windows"]], ["five", SNOWDON_FIVE]]) {
      const shot = await capture(`${label}-${scopeLabel}`, snowdon.path, viewId, { markCategories: categories });
      if (!check(`${label} ${scopeLabel}: marked`, !shot.error, shot.error)) continue;
      check(`${label} ${scopeLabel}: legend well formed and in scope`, legendWellFormed(shot.value.marks, shot.value.image.width, shot.value.image.height)
        && inScope(shot.value.marks, categories), null);
      // Scoped coverage is measured, not judged.
      console.log(JSON.stringify({ observation: "scoped coverage", view: label, type: shot.value.view.type, scope: categories, ...counts(shot) }));
    }
  }
  const site = await capture("snowdon-transverse-site", snowdon.path, snowdon.section, { markCategories: ["OST_Site"] });
  check(`element ${snowdon.unmarkedId} has no mark with OST_Site in scope`, !site.error && !site.value.marks.legend.some(row => row.elementId === snowdon.unmarkedId), site.error ?? counts(site));
  const asked = await capture("snowdon-transverse-requested", snowdon.path, snowdon.section, { markElementIds: [snowdon.unmarkedId] });
  check(`element ${snowdon.unmarkedId} requested: no mark, not_visible`, asked.value?.marks.legend.length === 0 && asked.value?.marks.notMarked?.[0]?.reason === "not_visible", asked.value?.marks ?? asked.error);

  // --- The receipt explains its limits ---
  for (const [label, document, viewId, categories] of [
    ["receipt-plan", snowdon.path, snowdon.plan, ["OST_Walls"]],
    ["receipt-section", snowdon.path, snowdon.section, ["OST_Walls"]],
    ["receipt-3d", snowdon.path, snowdon.threeD, ["OST_Walls"]],
    ["receipt-3d-levels", snowdon.path, snowdon.threeD, ["OST_Walls", "OST_Levels"]],
  ]) {
    const shot = await capture(label, document, viewId, { markCategories: categories });
    check(`${label}: summary and notes say no mark is not no element; notes for ${shot.value?.view.type}`,
      !shot.error && receiptSays(shot) && shot.value.marks.notes.length === expectedNotes(shot.value.view.type, categories), shot.value?.marks.notes ?? shot.error);
  }

  // --- The plan limit behaves as stated ---
  const symbol = await capture("plan-limit-symbol", fixture.symbolPath, fixture.symbolPlan, { markCategories: [fixture.symbolCategory] });
  check(`symbol-only family ${fixture.symbolFamily} gets no mark and counts in omitted`,
    !symbol.error && !symbol.value.marks.legend.some(row => row.elementId === fixture.symbolFamily) && symbol.value.marks.omitted >= 1, symbol.value?.marks ?? symbol.error);
  const planDoors = await capture("plan-limit-snowdon-doors", snowdon.path, snowdon.plan, { markCategories: ["OST_Doors"] });
  check("Snowdon plan with OST_Doors succeeds", !planDoors.error && inScope(planDoors.value.marks, ["OST_Doors"]), counts(planDoors));
  const elevationDoors = await capture("plan-limit-snowdon-elevation-doors", snowdon.path, snowdon.elevation, { markCategories: ["OST_Doors"] });
  check("Snowdon elevation with OST_Doors marks doors", !elevationDoors.error && elevationDoors.value.marks.legend.length > 0, counts(elevationDoors));

  // --- Failures are explicit and leave no artifact ---
  const before = sessionFiles();
  const six = ["OST_Walls", "OST_Doors", "OST_Windows", "OST_Floors", "OST_Roofs", "OST_Columns"];
  for (const [label, document, viewId, extra, pattern] of [
    ["perspective", snowdon.path, snowdon.perspective, { markCategories: ["OST_Walls"] }, /^MARKS_UNAVAILABLE: /],
    ["fixture perspective", fixture.path, fixture.perspective, { markElementIds: [fixture.referencePlane] }, /^MARKS_UNAVAILABLE: /],
    ["malformed id", snowdon.path, snowdon.plan, { markElementIds: ["12a"] }, /^INVALID_ELEMENT_ID: /],
    ["empty categories", snowdon.path, snowdon.plan, { markCategories: [] }, /^INVALID_MARK_CATEGORY: /],
    ["six categories", snowdon.path, snowdon.plan, { markCategories: six }, /^INVALID_MARK_CATEGORY: /],
    ["display name", snowdon.path, snowdon.plan, { markCategories: ["Doors"] }, /^INVALID_MARK_CATEGORY: /],
    ["misspelt", snowdon.path, snowdon.plan, { markCategories: ["OST_Door"] }, /^INVALID_MARK_CATEGORY: /],
    ["rooms", snowdon.path, snowdon.plan, { markCategories: ["OST_Rooms"] }, /^INVALID_MARK_CATEGORY: /],
    ["annotation", snowdon.path, snowdon.plan, { markCategories: ["OST_TextNotes"] }, /^INVALID_MARK_CATEGORY: /],
  ]) {
    const failed = await capture(`failure-${label.replace(/ /g, "-")}`, document, viewId, extra);
    check(`failure ${label}`, failed.error && pattern.test(failed.error) && failed.images === 0, failed.error);
  }
  check("failures left no artifact", JSON.stringify(sessionFiles()) === JSON.stringify(before), sessionFiles().length - before.length);
  const reasons = await capture("fixture-reasons", fixture.path, fixture.iso, { markElementIds: ["999999999", fixture.referencePlane] });
  const rows = Object.fromEntries((reasons.value?.marks.notMarked ?? []).map(row => [row.elementId, row.reason]));
  check("unknown id is not_found, reference plane is not_markable", rows["999999999"] === "not_found" && rows[fixture.referencePlane] === "not_markable", rows);
  const nothing = await capture("valid-category-nothing-in-view", fixture.path, fixture.plan, { markCategories: ["OST_Furniture"] });
  check("a valid category with nothing in the view returns an image and an empty legend", !nothing.error && nothing.value.marks.legend.length === 0, nothing.value?.marks ?? nothing.error);
  const big = await capture("largest-marked", snowdon.path, snowdon.shaded ?? snowdon.threeD, { markCategories: SNOWDON_FIVE, pixelSize: 2048 });
  console.log(JSON.stringify({ observation: "largest marked capture at 2048 px", bytes: big.value?.image.byteSize ?? null, error: big.error ?? null }));

  // --- Cost: added time at about 500 elements, median of 3 at 1024 px, one and five categories ---
  for (const [label, viewId] of [["plan", snowdon.plan], ["transverse", snowdon.section], ["cutaway", snowdon.cutaway]]) {
    for (const [scopeLabel, categories] of [["one", ["OST_Walls"]], ["five", SNOWDON_FIVE]]) {
      const plainMs = [];
      const markedMs = [];
      for (let run = 0; run < 3; run += 1) {
        plainMs.push((await capture(`cost-${label}-${scopeLabel}-plain-${run}`, snowdon.path, viewId)).ms);
        markedMs.push((await capture(`cost-${label}-${scopeLabel}-marked-${run}`, snowdon.path, viewId, { markCategories: categories })).ms);
      }
      const added = median(markedMs) - median(plainMs);
      check(`cost ${label} ${scopeLabel} category: added under 2 s`, added < 2000, { plainMs, markedMs, addedMs: added });
    }
  }
} finally {
  await client.close();
}
console.log(JSON.stringify({ summary: failures === 0 ? "passed" : "failed", failures }));
process.exitCode = failures === 0 ? 0 : 1;
