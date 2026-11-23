import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriveItServer, SERVER_INSTRUCTIONS } from "../server/app.js";
import {
  BROKER_BUDGET, launchRootFrom, MARKER_SCHEMA, MAX_IMAGE_BYTES, ownerState, pngDimensions, processStartTime,
  REFERENCE_DIRECTORY, ReferenceImages, retentionFrom, SESSION_MARKER, sweepSession,
} from "../server/capture.js";
import { Runtime } from "../server/runtime.js";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable grey RGB PNG. */
function png(width, height, shade = 0x80) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, shade)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const VIEW = { viewId: "312", viewUniqueId: "abc-312", viewName: "Level 1", viewType: "FloorPlan" };
const DOCUMENT = { uniqueId: "doc-handle", title: "Tower", path: "C:\\models\\tower.rvt", kind: "rvt", isReadOnly: false };

/** Plays the add-in: writes a PNG at the server's target and answers like ViewCapture.cs. */
function fakeBroker({ bytes = png(64, 48), envelopes = [], respond, receipt = {} } = {}) {
  return async (processId, envelope, options = {}) => {
    envelopes.push({ processId, envelope, options });
    // Like executeBroker: the pipe greeting of this connection names the Revit version.
    options.onSession?.({ processId, version: "2026", build: "26.0.4.409", connectionIdentity: "test" });
    if (respond) return respond(envelope, options);
    await writeFile(envelope.capture.targetPath, typeof bytes === "function" ? bytes(envelope) : bytes);
    return {
      id: envelope.id,
      type: "view.capture",
      status: "succeeded",
      document: DOCUMENT,
      capture: {
        ...VIEW,
        pixelSize: envelope.capture.pixelSize,
        fitDirection: "Horizontal",
        outputPath: envelope.capture.targetPath,
        documentModifiedBefore: false,
        documentModifiedAfter: false,
        temporaryViewCreated: false,
        transactionStarted: false,
        ...receipt,
      },
    };
  };
}

const sessionReader = async processId => ({ processId, version: "2026", build: "26.0.4.409", connectionIdentity: "test" });
// Capture must not open a second pipe connection for session info; this reader proves it.
const forbiddenReader = async () => {
  throw new Error("capture opened a separate session connection");
};

async function base(t, name) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `drive-it-${name}-`)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function connected(t, options) {
  const { server, references, runtime } = createDriveItServer({
    processResolver: async processId => processId ?? 4242,
    sessionReader,
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drive-it-capture-test", version: "1" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  await client.listTools();
  return { client, references, runtime };
}

function capture(client, args = {}) {
  return client.callTool({ name: "capture_revit_view", arguments: { purpose: "Check the floor plan", ...args } });
}

async function listTree(directory) {
  if (!existsSync(directory)) return [];
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    out.push(path.relative(directory, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join("/"));
  }
  return out.sort();
}

test("launch root, retention mode, and PNG parsing", () => {
  assert.equal(launchRootFrom({ DRIVE_IT_LAUNCH_ROOT: "  " }, "/home/u"), path.resolve("/home/u/Drive-It"));
  assert.equal(launchRootFrom({ DRIVE_IT_LAUNCH_ROOT: "/elsewhere" }, "/home/u"), path.resolve("/elsewhere"));
  const warnings = [];
  assert.equal(retentionFrom(undefined), "session");
  assert.equal(retentionFrom(" Keep "), "keep");
  assert.equal(retentionFrom("forever", message => warnings.push(message)), "session");
  assert.equal(warnings.length, 1);
  assert.deepEqual(pngDimensions(png(300, 20)), { width: 300, height: 20 });
  assert.equal(pngDimensions(png(3, 2).subarray(0, 40)), null);
  assert.equal(pngDimensions(Buffer.from("not a png at all, just some bytes long enough to parse......")), null);
});

test("discovery carries the visual QA rule and honest annotations", async (t) => {
  const launchRoot = await base(t, "discover");
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker() });
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  assert.match(SERVER_INSTRUCTIONS, /capture_revit_view/);
  assert.match(SERVER_INSTRUCTIONS, /visual evidence is missing/);
  const { tools } = await client.listTools();
  const tool = tools.find(candidate => candidate.name === "capture_revit_view");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.match(tool.description, /does not modify the Revit model; it writes a local reference image/);
  assert.match(tool.description, /never claim a visual pass/);
  assert.deepEqual(tool.inputSchema.required, ["purpose"]);
  for (const name of ["processId", "document", "viewId", "pixelSize", "relatedRunIds", "retain"]) {
    assert.ok(tool.inputSchema.properties[name], name);
  }
  assert.equal(tool.inputSchema.properties.pixelSize.minimum, 256);
  assert.equal(tool.inputSchema.properties.pixelSize.maximum, 2048);
  assert.equal(tool.inputSchema.properties.targetPath, undefined);
});

test("a capture returns the saved PNG bytes, metadata and a complete sidecar under the launch root only", async (t) => {
  const directory = await base(t, "capture");
  const launchRoot = path.join(directory, "launch");
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const runtime = new Runtime({ dataDir: path.join(directory, "data") });
  await runtime.workspace.setRoot(workspace);
  const envelopes = [];
  const bytes = png(120, 80);
  const { client, references } = await connected(t, { runtime, launchRoot, sessionReader: forbiddenReader, brokerExecutor: fakeBroker({ bytes, envelopes }) });

  const result = await capture(client, {
    processId: 777,
    viewId: 312,
    document: { uniqueId: "doc-handle" },
    relatedRunIds: ["run-1", "run-2"],
  });
  assert.ok(!result.isError, result.content[0].text);
  const [image, text] = result.content;
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(text.type, "text");
  assert.match(text.text, /deleted when this session ends/);

  const value = result.structuredContent;
  const sessionDirectory = path.join(launchRoot, REFERENCE_DIRECTORY, references.sessionId);
  assert.equal(value.absolutePath, path.join(sessionDirectory, `${value.captureId}.png`));
  assert.equal(value.image.path, `${REFERENCE_DIRECTORY}/${references.sessionId}/${value.captureId}.png`);
  assert.equal(value.sidecarPath, `${REFERENCE_DIRECTORY}/${references.sessionId}/${value.captureId}.json`);

  const saved = await readFile(value.absolutePath);
  assert.deepEqual(saved, bytes);
  assert.deepEqual(Buffer.from(image.data, "base64"), saved);
  assert.equal(value.image.sha256, createHash("sha256").update(saved).digest("hex"));
  assert.equal(value.image.byteSize, saved.length);
  assert.deepEqual([value.image.width, value.image.height], [120, 80]);

  const sidecar = JSON.parse(await readFile(path.join(launchRoot, value.sidecarPath), "utf8"));
  const { absolutePath, sidecarPath, ...metadata } = value;
  assert.deepEqual(sidecar, metadata);
  assert.equal(sidecar.schema, "drive-it.reference-image/1");
  assert.equal(sidecar.sessionId, references.sessionId);
  assert.ok(Date.parse(sidecar.createdAt));
  assert.equal(sidecar.purpose, "Check the floor plan");
  assert.deepEqual(sidecar.relatedRunIds, ["run-1", "run-2"]);
  assert.deepEqual(sidecar.retention, { mode: "session", requested: false, retained: false, survivesSessionEnd: false });
  assert.deepEqual(sidecar.revit, { processId: 777, version: "2026", build: "26.0.4.409" });
  assert.deepEqual(sidecar.document, { uniqueId: "doc-handle", title: "Tower", path: "C:\\models\\tower.rvt", kind: "rvt" });
  assert.deepEqual(sidecar.view, { id: "312", uniqueId: "abc-312", name: "Level 1", type: "FloorPlan" });
  assert.deepEqual(sidecar.export, {
    mechanism: "Document.ExportImage",
    requestedPixelSize: 1024,
    fitDirection: "Horizontal",
    temporaryViewCreated: false,
    transactionStarted: false,
    documentModifiedBefore: false,
    documentModifiedAfter: false,
  });

  // The broker got a typed request with a server-made target in an empty staging directory.
  assert.equal(envelopes.length, 1);
  const { processId, envelope } = envelopes[0];
  assert.equal(processId, 777);
  assert.equal(envelope.type, "view.capture");
  assert.equal(envelope.id, value.captureId);
  assert.deepEqual(envelope.document, { path: null, uniqueId: "doc-handle" });
  assert.equal(envelope.capture.viewId, "312");
  assert.equal(envelope.capture.pixelSize, 1024);
  assert.equal(envelope.capture.targetPath, path.join(sessionDirectory, `.tmp-${value.captureId}`, `${value.captureId}.png`));

  // Only the pair and the owner marker exist, and nothing reached the modeling workspace.
  assert.deepEqual(await listTree(sessionDirectory), [SESSION_MARKER, `${value.captureId}.json`, `${value.captureId}.png`].sort());
  assert.deepEqual(await listTree(workspace), []);
  const marker = JSON.parse(await readFile(path.join(sessionDirectory, SESSION_MARKER), "utf8"));
  assert.equal(marker.schema, MARKER_SCHEMA);
  assert.equal(marker.processId, process.pid);
  assert.equal(marker.hostname, hostname());
  // The marker records the OS-reported start time, the same source the stale sweep compares.
  assert.equal(marker.processStartSource, "os");
  assert.ok(Math.abs(Date.parse(marker.processStartedAt) - (Date.now() - process.uptime() * 1000)) < 10_000);
  // The pipe budget fits the 150 s tool timeout of Codex and ChatGPT.
  assert.deepEqual(envelopes[0].options.connectWaitMs, BROKER_BUDGET.connectWaitMs);
  assert.ok(BROKER_BUDGET.connectWaitMs + BROKER_BUDGET.timeoutMs <= 135_000);
});

test("pixelSize is bounded to 256 through 2048", async (t) => {
  const launchRoot = await base(t, "pixels");
  const envelopes = [];
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ envelopes }) });
  for (const pixelSize of [255, 2049, 1000.5]) {
    const result = await capture(client, { pixelSize });
    assert.equal(result.isError, true, `pixelSize ${pixelSize}`);
  }
  assert.equal(envelopes.length, 0);
  for (const pixelSize of [256, 2048]) {
    const result = await capture(client, { pixelSize });
    assert.ok(!result.isError, result.content[0]?.text);
    assert.equal(result.structuredContent.export.requestedPixelSize, pixelSize);
  }
  assert.deepEqual(envelopes.map(item => item.envelope.capture.pixelSize), [256, 2048]);
  const missingPurpose = await client.callTool({ name: "capture_revit_view", arguments: {} });
  assert.equal(missingPurpose.isError, true);
});

test("an over-limit, invalid, or failed export returns an error and leaves no pair", async (t) => {
  const launchRoot = await base(t, "failures");
  const big = Buffer.concat([png(4, 4).subarray(0, 33), Buffer.alloc(MAX_IMAGE_BYTES)]);
  let mode = "big";
  const brokerExecutor = fakeBroker({ bytes: () => (mode === "big" ? big : Buffer.from("GIF89a fake image bytes")) });
  const rejecting = async (processId, envelope) => {
    if (mode !== "rejected") return brokerExecutor(processId, envelope);
    return {
      id: envelope.id,
      type: "view.capture",
      status: "failed",
      document: DOCUMENT,
      capture: { availableViews: [{ id: "312", name: "Level 1", type: "FloorPlan" }] },
      error: { code: "unsupported_view_type", message: "View 'Sheet A1' (99) is a DrawingSheet view." },
    };
  };
  const { client, references } = await connected(t, { launchRoot, brokerExecutor: rejecting });
  const sessionDirectory = path.join(launchRoot, REFERENCE_DIRECTORY, references.sessionId);

  const tooLarge = await capture(client);
  assert.equal(tooLarge.isError, true);
  assert.equal(tooLarge.content.length, 1);
  assert.match(tooLarge.content[0].text, /^CAPTURE_TOO_LARGE: .*smaller pixelSize.*No image was captured/);

  mode = "invalid";
  const invalid = await capture(client);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /^INVALID_IMAGE:/);

  mode = "rejected";
  const rejected = await capture(client, { viewId: "99" });
  assert.equal(rejected.isError, true);
  assert.ok(!rejected.content.some(block => block.type === "image"));
  assert.match(rejected.content[0].text, /^UNSUPPORTED_VIEW_TYPE: View 'Sheet A1'/);
  assert.match(rejected.content[0].text, /"availableViews":\[\{"id":"312"/);

  // Only the owner marker: no image, sidecar, or staging directory survived any failure.
  assert.deepEqual(await listTree(sessionDirectory), [SESSION_MARKER]);
});

test("a linked _reference-images directory is rejected rather than followed", async (t) => {
  const directory = await base(t, "linked");
  const launchRoot = path.join(directory, "launch");
  const elsewhere = path.join(directory, "elsewhere");
  await mkdir(launchRoot);
  await mkdir(elsewhere);
  await symlink(elsewhere, path.join(launchRoot, REFERENCE_DIRECTORY), process.platform === "win32" ? "junction" : "dir");
  const envelopes = [];
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ envelopes }) });
  const result = await capture(client);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^REFERENCE_DIRECTORY_LINKED:/);
  assert.equal(envelopes.length, 0);
  assert.deepEqual(await listTree(elsewhere), []);
});

test("a session directory swapped for a link after the first capture is rejected", async (t) => {
  const directory = await base(t, "swapped");
  const launchRoot = path.join(directory, "launch");
  const elsewhere = path.join(directory, "elsewhere");
  await mkdir(elsewhere);
  const { client, references } = await connected(t, { launchRoot, brokerExecutor: fakeBroker() });
  assert.ok(!(await capture(client)).isError);
  const sessionDirectory = path.join(launchRoot, REFERENCE_DIRECTORY, references.sessionId);
  await rm(sessionDirectory, { recursive: true });
  await symlink(elsewhere, sessionDirectory, process.platform === "win32" ? "junction" : "dir");
  const result = await capture(client);
  assert.match(result.content[0].text, /^REFERENCE_DIRECTORY_LINKED:/);
  assert.deepEqual(await listTree(elsewhere), []);
});

test("concurrent sessions keep separate directories, and one's shutdown leaves the other intact", async (t) => {
  const launchRoot = await base(t, "concurrent");
  const first = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker({ bytes: png(10, 10, 1) }) });
  const second = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker({ bytes: png(10, 10, 2) }) });
  assert.notEqual(first.sessionId, second.sessionId);
  const request = { processId: 1, purpose: "same document, two agents" };
  const results = await Promise.all([first, second, first, second].map(store => store.capture(request)));
  const ids = new Set(results.map(result => result.metadata.captureId));
  assert.equal(ids.size, 4);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(await readFile(result.absolutePath), png(10, 10, index % 2 === 0 ? 1 : 2));
  }

  first.closeSync();
  assert.ok(!existsSync(first.sessionDirectory));
  for (const result of results.filter(item => item.metadata.sessionId === second.sessionId)) {
    assert.ok(existsSync(result.absolutePath));
    assert.ok(existsSync(result.sidecarPath));
  }
  await assert.rejects(first.capture(request), { code: "SESSION_CLOSING" });
});

test("session shutdown removes unretained pairs and keeps retained ones", async (t) => {
  const launchRoot = await base(t, "shutdown");
  const { client, references } = await connected(t, { launchRoot, brokerExecutor: fakeBroker() });
  const dropped = await capture(client);
  const kept = await capture(client, { retain: true });
  assert.deepEqual(kept.structuredContent.retention, { mode: "session", requested: true, retained: true, survivesSessionEnd: true });
  assert.match(kept.content[1].text, /kept after this session ends/);

  const result = references.closeSync();
  assert.deepEqual(result.errors, []);
  assert.ok(!existsSync(dropped.structuredContent.absolutePath));
  assert.ok(!existsSync(path.join(launchRoot, dropped.structuredContent.sidecarPath)));
  assert.ok(existsSync(kept.structuredContent.absolutePath));
  assert.ok(existsSync(path.join(launchRoot, kept.structuredContent.sidecarPath)));
  assert.ok(existsSync(path.join(references.sessionDirectory, SESSION_MARKER)));

  // A session that only captured unretained images leaves no directory behind.
  const other = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker() });
  await other.capture({ processId: 1, purpose: "temporary" });
  other.closeSync();
  assert.ok(!existsSync(other.sessionDirectory));
  assert.ok(existsSync(path.join(launchRoot, REFERENCE_DIRECTORY)));
  // A session that never captured has nothing to clean.
  assert.equal(new ReferenceImages({ launchRoot }).closeSync(), null);
});

test("keep mode preserves every capture and says so", async (t) => {
  const launchRoot = await base(t, "keep");
  const { client, references } = await connected(t, { launchRoot, referenceRetention: "keep", brokerExecutor: fakeBroker() });
  const result = await capture(client);
  assert.deepEqual(result.structuredContent.retention, { mode: "keep", requested: false, retained: true, survivesSessionEnd: true });
  references.closeSync();
  assert.ok(existsSync(result.structuredContent.absolutePath));
});

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
}

async function fakeSession(references, sessionId, marker, files = {}) {
  const directory = path.join(references, sessionId);
  await mkdir(directory, { recursive: true });
  if (marker) await writeFile(path.join(directory, SESSION_MARKER), JSON.stringify({ schema: MARKER_SCHEMA, sessionId, hostname: hostname(), ...marker }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}

function pair(captureId, retained) {
  return {
    [`${captureId}.png`]: png(2, 2),
    [`${captureId}.json`]: JSON.stringify({ captureId, retention: { retained } }),
  };
}

test("startup removes unretained artifacts only of provably dead sessions", async (t) => {
  const launchRoot = await base(t, "stale");
  const references = path.join(launchRoot, REFERENCE_DIRECTORY);
  // A far-past start makes the owner dead whether the pid is gone or already reused.
  const pid = await deadPid();
  const past = "2000-01-01T00:00:00.000Z";
  const dead = await fakeSession(references, "20261101T000000Z-0000000a", { processId: pid, processStartedAt: past }, {
    ...pair("20261101T000001Z-00000001", false),
    ...pair("20261101T000002Z-00000002", true),
    "20261101T000003Z-00000003.png": png(2, 2),
    ".tmp-20261101T000004Z-00000004/export - 3D View - {3D}.png": png(2, 2),
    "notes.txt": "user file",
  });
  const deadEmpty = await fakeSession(references, "20261101T000000Z-0000000b", { processId: pid, processStartedAt: past },
    pair("20261101T000005Z-00000005", false));
  const osStart = await processStartTime(process.pid);
  assert.equal(typeof osStart, "number");
  const alive = await fakeSession(references, "20261101T000000Z-0000000c",
    { processId: process.pid, processStartedAt: new Date(osStart).toISOString() },
    pair("20261101T000006Z-00000006", false));
  const unowned = await fakeSession(references, "20261101T000000Z-0000000d", null, pair("20261101T000007Z-00000007", false));
  const foreign = await fakeSession(references, "20261101T000000Z-0000000e",
    { hostname: `not-${hostname()}`, processId: pid, processStartedAt: past }, pair("20261101T000008Z-00000008", false));
  const hostless = await fakeSession(references, "20261101T000000Z-0000000f",
    { hostname: undefined, processId: pid, processStartedAt: past }, pair("20261101T000009Z-00000009", false));
  await writeFile(path.join(references, "unrelated.png"), "keep me");
  await mkdir(path.join(references, "my-folder"));

  const store = new ReferenceImages({ launchRoot });
  const swept = await store.cleanupStaleSessions();
  assert.deepEqual(swept.map(item => item.sessionId).sort(), ["20261101T000000Z-0000000a", "20261101T000000Z-0000000b"]);

  assert.deepEqual(await listTree(dead), [
    SESSION_MARKER, "20261101T000002Z-00000002.json", "20261101T000002Z-00000002.png", "notes.txt",
  ].sort());
  assert.ok(!existsSync(deadEmpty));
  assert.equal((await listTree(alive)).length, 3);
  assert.equal((await listTree(unowned)).length, 2);
  // Another machine's session in a synced or redirected Documents folder is never swept.
  assert.equal((await listTree(foreign)).length, 3);
  assert.equal((await listTree(hostless)).length, 3);
  assert.ok(existsSync(path.join(references, "unrelated.png")));
  assert.ok(existsSync(path.join(references, "my-folder")));
});

test("a reused pid is dead; a live, matching, unreadable, or foreign owner is not", async () => {
  const host = hostname();
  const osStart = await processStartTime(process.pid);
  // The real lookup works and agrees with the uptime estimate.
  assert.equal(typeof osStart, "number");
  assert.ok(Math.abs(osStart - (Date.now() - process.uptime() * 1000)) < 10_000, `${osStart}`);
  const startedAt = new Date(osStart).toISOString();
  const pid = await deadPid();
  const past = "2000-01-01T00:00:00.000Z";
  assert.equal(await ownerState({ hostname: host, processId: pid, processStartedAt: past }), "dead");
  assert.equal(await ownerState({ hostname: host, processId: process.pid, processStartedAt: past }, { startTime: async () => Date.now() }), "dead");
  assert.equal(await ownerState({ hostname: host, processId: process.pid, processStartedAt: startedAt }, { startTime: async () => osStart + 500 }), "alive");
  assert.equal(await ownerState({ hostname: host, processId: process.pid, processStartedAt: startedAt }, { startTime: async () => null }), "alive");
  assert.equal(await ownerState({ hostname: host, processId: "x" }), "unknown");
  assert.equal(await ownerState({ processId: pid, processStartedAt: past }), "unknown");
  assert.equal(await ownerState({ hostname: `not-${host}`, processId: pid, processStartedAt: past }), "foreign");
  assert.equal(await ownerState({ hostname: host.toUpperCase(), processId: pid, processStartedAt: past }, { host: host.toLowerCase() }), "dead");
  assert.equal(await ownerState({ hostname: host, processId: process.pid, processStartedAt: startedAt }), "alive");
});

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("the stdio server sweeps dead sessions at startup under DRIVE_IT_LAUNCH_ROOT, not its cwd", async (t) => {
  const directory = await base(t, "stdio-stale");
  const launchRoot = path.join(directory, "launch");
  const cwd = path.join(directory, "cwd");
  await mkdir(cwd);
  const pid = await deadPid();
  const dead = await fakeSession(path.join(launchRoot, REFERENCE_DIRECTORY), "20261101T000000Z-000000aa",
    { processId: pid, processStartedAt: "2000-01-01T00:00:00.000Z" }, pair("20261101T000001Z-000000a1", false));
  const client = new Client({ name: "drive-it-capture-stdio", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server/index.js", import.meta.url))],
    cwd,
    env: { ...process.env, DRIVE_IT_DATA_DIR: path.join(directory, "data"), DRIVE_IT_LAUNCH_ROOT: launchRoot },
  });
  await client.connect(transport);
  // The child must be gone before the temporary tree is removed: Windows locks its cwd.
  const child = transport._process;
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "capture_revit_view"));
    await waitFor(() => !existsSync(dead));
    assert.ok(!existsSync(path.join(cwd, REFERENCE_DIRECTORY)));
  } finally {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});

// End to end over stdio and a real named pipe that plays the add-in: the protocol, the file
// handoff, and shutdown cleanup when the client goes away. A distinct fake process id keeps this
// pipe apart from other test files' pipes.
test("stdio capture through the pipe contract, then cleanup at client shutdown", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await base(t, "stdio-capture");
  const launchRoot = path.join(directory, "launch");
  const processId = 424250;
  const bytes = png(200, 100);
  const envelopes = [];
  const bridge = createServer(socket => {
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify({ processId, version: "2026", build: "test" })}\n`);
    let input = "";
    socket.on("data", async chunkText => {
      input += chunkText;
      if (!input.includes("\n")) return;
      const envelope = JSON.parse(input.split("\n")[0]);
      envelopes.push(envelope);
      await writeFile(envelope.capture.targetPath, bytes);
      socket.end(`${JSON.stringify({
        id: envelope.id,
        type: "view.capture",
        status: "succeeded",
        document: DOCUMENT,
        capture: { ...VIEW, outputPath: envelope.capture.targetPath, fitDirection: "Horizontal", documentModifiedBefore: false, documentModifiedAfter: false },
      })}\n`);
    });
  });
  bridge.listen(String.raw`\\.\pipe\drive-it-${processId}`);
  await once(bridge, "listening");
  t.after(() => new Promise(resolve => bridge.close(resolve)));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server/index.js", import.meta.url))],
    env: { ...process.env, DRIVE_IT_DATA_DIR: path.join(directory, "data"), DRIVE_IT_LAUNCH_ROOT: launchRoot },
  });
  const client = new Client({ name: "drive-it-capture-pipe", version: "1" });
  await client.connect(transport);
  const child = transport._process;
  let dropped;
  let kept;
  try {
    await client.listTools();
    dropped = await client.callTool({ name: "capture_revit_view", arguments: { processId, purpose: "pipe contract" } });
    assert.ok(!dropped.isError, dropped.content[0].text);
    assert.deepEqual(Buffer.from(dropped.content[0].data, "base64"), bytes);
    assert.deepEqual(await readFile(dropped.structuredContent.absolutePath), bytes);
    kept = await client.callTool({ name: "capture_revit_view", arguments: { processId, purpose: "keep this", retain: true, viewId: "312" } });
    assert.ok(!kept.isError, kept.content[0].text);
    assert.equal(envelopes[0].type, "view.capture");
    assert.equal(envelopes[1].capture.viewId, "312");
  } finally {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
  assert.ok(!existsSync(dropped.structuredContent.absolutePath));
  assert.ok(existsSync(kept.structuredContent.absolutePath));
});

// Windows types every reparse point as a symbolic link in Dirent, including OneDrive placeholders
// that are plain files and folders; the sweep must classify by lstat.
test("the sweep classifies entries by lstat, not by a Dirent that calls placeholders links", async (t) => {
  const launchRoot = await base(t, "placeholder");
  const references = path.join(launchRoot, REFERENCE_DIRECTORY);
  const directory = await fakeSession(references, "20261101T000000Z-000000c1", { processId: process.pid, processStartedAt: new Date().toISOString() }, {
    ...pair("20261101T000001Z-000000c1", false),
    ...pair("20261101T000002Z-000000c2", true),
    ".tmp-20261101T000003Z-000000c3/export.png": png(2, 2),
  });
  const placeholderDirents = target => readdirSync(target).map(name => ({
    name,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  }));
  const result = sweepSession(directory, { readdir: placeholderDirents });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await listTree(directory), [SESSION_MARKER, "20261101T000002Z-000000c2.json", "20261101T000002Z-000000c2.png"].sort());

  // The same injection reaches shutdown cleanup through the store.
  const store = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker(), readdir: placeholderDirents });
  await store.capture({ processId: 1, purpose: "placeholder shutdown" });
  store.closeSync();
  assert.ok(!existsSync(store.sessionDirectory));
});

test("a failed marker write leaves no orphan folder and the next capture succeeds", async (t) => {
  const launchRoot = await base(t, "marker");
  class FlakyMarker extends ReferenceImages {
    async writeAtomic(file, value, temporaryName) {
      if (path.basename(file) === SESSION_MARKER && !this.failedOnce) {
        this.failedOnce = true;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      }
      return super.writeAtomic(file, value, temporaryName);
    }
  }
  const store = new FlakyMarker({ launchRoot, brokerExecutor: fakeBroker() });
  await assert.rejects(store.capture({ processId: 1, purpose: "first" }), { code: "ARTIFACT_WRITE_FAILED" });
  assert.ok(!existsSync(store.sessionDirectory));
  const second = await store.capture({ processId: 1, purpose: "second" });
  assert.ok(existsSync(second.absolutePath));
  assert.ok(existsSync(path.join(store.sessionDirectory, SESSION_MARKER)));
});

test("a session folder deleted mid-session is recreated with its marker", async (t) => {
  const launchRoot = await base(t, "recreate");
  const store = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker() });
  await store.capture({ processId: 1, purpose: "first" });
  await rm(path.join(launchRoot, REFERENCE_DIRECTORY), { recursive: true });
  const second = await store.capture({ processId: 1, purpose: "after the user emptied _reference-images" });
  assert.ok(existsSync(second.absolutePath));
  assert.ok(existsSync(path.join(store.sessionDirectory, SESSION_MARKER)));
});

test("broker, publish, size, modification, and shutdown failures leave no pair", async (t) => {
  const launchRoot = await base(t, "paths");
  const tree = store => listTree(store.sessionDirectory);

  const throwing = new ReferenceImages({ launchRoot, brokerExecutor: async () => { throw new Error("Revit connection timed out."); } });
  await assert.rejects(throwing.capture({ processId: 1, purpose: "timeout" }), error => error.code === "EXPORT_FAILED" && /timed out/.test(error.message));
  assert.deepEqual(await tree(throwing), [SESSION_MARKER]);

  class FailingSidecar extends ReferenceImages {
    async writeAtomic(file, value, temporaryName) {
      if (path.basename(file) !== SESSION_MARKER) throw new Error("ENOSPC: no space left on device");
      return super.writeAtomic(file, value, temporaryName);
    }
  }
  const publishing = new FailingSidecar({ launchRoot, brokerExecutor: fakeBroker() });
  await assert.rejects(publishing.capture({ processId: 1, purpose: "disk full" }), error => error.code === "ARTIFACT_WRITE_FAILED" && error.detail.stage === "store");
  assert.deepEqual(await tree(publishing), [SESSION_MARKER]);

  const oversized = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker({ bytes: png(300, 6000) }) });
  await assert.rejects(oversized.capture({ processId: 1, purpose: "tall", pixelSize: 256 }), { code: "CAPTURE_SIZE_EXCEEDED" });
  assert.deepEqual(await tree(oversized), [SESSION_MARKER]);
  const rounded = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker({ bytes: png(258, 100) }) });
  assert.equal((await rounded.capture({ processId: 1, purpose: "rounding", pixelSize: 256 })).metadata.image.width, 258);

  const dirtied = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker({ receipt: { documentModifiedAfter: true } }) });
  await assert.rejects(dirtied.capture({ processId: 1, purpose: "dirty" }), { code: "DOCUMENT_MODIFIED_BY_CAPTURE" });
  assert.deepEqual(await tree(dirtied), [SESSION_MARKER]);

  // Shutdown while Revit is exporting: the late result is discarded and the folder goes.
  let closing;
  const inFlight = new ReferenceImages({
    launchRoot,
    brokerExecutor: async (processId, envelope, options) => {
      const response = await fakeBroker()(processId, envelope, options);
      closing.closeSync();
      return response;
    },
  });
  closing = inFlight;
  await assert.rejects(inFlight.capture({ processId: 1, purpose: "shutdown" }), { code: "SESSION_CLOSING" });
  assert.ok(!existsSync(inFlight.sessionDirectory));
});

test("selection errors pass view lists, totals, and an add-in restart hint through", async (t) => {
  const launchRoot = await base(t, "lists");
  const respond = code => envelope => ({
    id: envelope.id,
    type: "view.capture",
    status: "failed",
    document: DOCUMENT,
    capture: {
      availableViews: [{ id: "312", name: "Level 1", type: "FloorPlan" }],
      otherViews: [{ id: "99", name: "A101", type: "DrawingSheet", notCapturable: "unsupported_view_type" }],
      availableViewsTotal: 41, otherViewsTotal: 7, viewsListedPerType: 20, otherViewsListedPerType: 5,
    },
    error: { code, message: "View 'A101' (99) is a DrawingSheet view." },
  });
  const store = new ReferenceImages({ launchRoot, brokerExecutor: fakeBroker({ respond: respond("unsupported_view_type") }) });
  await assert.rejects(store.capture({ processId: 1, purpose: "sheet", viewId: "99" }), error => {
    assert.equal(error.code, "UNSUPPORTED_VIEW_TYPE");
    assert.equal(error.detail.otherViews[0].notCapturable, "unsupported_view_type");
    assert.equal(error.detail.availableViewsTotal, 41);
    assert.equal(error.detail.otherViewsListedPerType, 5);
    return true;
  });
  const stale = new ReferenceImages({
    launchRoot,
    brokerExecutor: fakeBroker({ respond: envelope => ({ id: envelope.id, status: "failed", error: { code: "unsupported_request", message: "The request type must be 'model.execute'." } }) }),
  });
  await assert.rejects(stale.capture({ processId: 1, purpose: "old add-in" }), error => error.code === "UNSUPPORTED_REQUEST" && /restart Revit/.test(error.message));
});
