import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { duplexPair } from "node:stream";
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
import { executeBroker } from "../server/session.js";

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

test("execute_script exposes createdViews and its id feeds capture_revit_view", async (t) => {
  const launchRoot = await base(t, "created-view");
  const view = { id: "354981", name: "Drive It QA 3D", type: "ThreeD" };
  const envelopes = [];
  let createdId = view.id;
  const capturer = fakeBroker({ envelopes, receipt: { viewId: view.id, viewName: view.name, viewType: view.type } });
  const brokerExecutor = async (processId, envelope, options) => envelope.type === "model.execute"
    ? {
      id: envelope.id, status: "succeeded", document: DOCUMENT, changes: [`Created 3D view '${view.name}'.`],
      affectedFiles: [], affectedElements: [Number(view.id)], checks: [], createdViews: [{ ...view, id: createdId }],
    }
    : capturer(processId, envelope, options);
  const { client, runtime } = await connected(t, { launchRoot, dataDir: path.join(launchRoot, "data"), brokerExecutor });
  await mkdir(path.join(launchRoot, "ws"));
  await runtime.workspace.setRoot(path.join(launchRoot, "ws"));

  const run = await client.callTool({ name: "execute_script", arguments: {
    processId: 4242, displayName: "Create a QA 3D view", source: "revit.create_3d_view(name='Drive It QA 3D')", idempotencyKey: "qa-view",
  } });
  assert.ok(!run.isError, run.content[0].text);
  assert.deepEqual(run.structuredContent.createdViews, [view]);
  const shot = await capture(client, { document: { uniqueId: DOCUMENT.uniqueId }, viewId: run.structuredContent.createdViews[0].id });
  assert.ok(!shot.isError, shot.content[0].text);
  assert.equal(envelopes.at(-1).envelope.capture.viewId, view.id);

  // A numeric id (the precision loss the string id avoids) does not pass the published output schema.
  createdId = Number(view.id);
  const numeric = await client.callTool({ name: "execute_script", arguments: {
    processId: 4242, displayName: "Create another QA 3D view", source: "revit.create_3d_view()", idempotencyKey: "qa-view-numeric",
  } }).then(result => result, error => ({ isError: true, content: [{ text: error.message }] }));
  assert.equal(numeric.isError, true);
});

test("discovery carries the visual QA rule and honest annotations", async (t) => {
  const launchRoot = await base(t, "discover");
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker() });
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  assert.match(SERVER_INSTRUCTIONS, /capture_revit_view/);
  assert.match(SERVER_INSTRUCTIONS, /visual evidence is missing/);
  assert.match(SERVER_INSTRUCTIONS, /no suitable 3D view exists, create one with the create_3d_view operation/);
  assert.match(SERVER_INSTRUCTIONS, /reuse a 3D view you created earlier in the session/);
  assert.match(SERVER_INSTRUCTIONS, /tell the user you added that view to their model/);
  const { tools } = await client.listTools();
  const tool = tools.find(candidate => candidate.name === "capture_revit_view");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.match(tool.description, /does not modify the Revit model; it writes a local reference image/);
  assert.match(tool.description, /never claim a visual pass/);
  assert.match(tool.description, /create_3d_view/);
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
  // The marker prefers the OS-reported start time; a loaded runner can time the lookup out and
  // fall back to the estimate. The real lookup is proven in the reused-pid test below.
  assert.ok(["os", "estimate"].includes(marker.processStartSource), marker.processStartSource);
  assert.ok(Math.abs(Date.parse(marker.processStartedAt) - (Date.now() - process.uptime() * 1000)) < 10_000);
  // The capture waits on a busy pipe until it frees, with a signal that ends the wait if the request
  // is cancelled or the session closes; the hold tests below prove both on a busy pipe.
  const { signal, onSession } = envelopes[0].options;
  assert.deepEqual(envelopes[0].options, { ...BROKER_BUDGET, signal, onSession });
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.equal(BROKER_BUDGET.connectWaitMs, Infinity);
});

/**
 * Revit's pipe while a script run holds it: busy (EBUSY) for holdMs from the capture's first
 * attempt, then one connection that greets and serves the capture like the add-in. Time is
 * node:test's mocked clock.
 */
function heldPipe(holdMs, { answer = true } = {}) {
  const served = [];
  const revit = fakeBroker();
  const pipe = { served, answer, firstAttemptAt: null, connected: false };
  pipe.connector = () => {
    pipe.firstAttemptAt ??= Date.now();
    if (Date.now() < pipe.firstAttemptAt + holdMs) {
      const busy = new EventEmitter();
      busy.destroy = () => {};
      setImmediate(() => busy.emit("error", Object.assign(new Error("connect EBUSY"), { code: "EBUSY" })));
      return busy;
    }
    pipe.connected = true;
    const [client, addIn] = duplexPair();
    setImmediate(() => client.emit("connect"));
    addIn.setEncoding("utf8");
    addIn.write(`${JSON.stringify({ processId: 4242, version: "2026", build: "26.0.4.409" })}\n`);
    let buffered = "";
    addIn.on("data", async chunk => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const envelope = JSON.parse(buffered);
      served.push({ envelope, at: Date.now() });
      if (answer) addIn.write(`${JSON.stringify(await revit(4242, envelope))}\n`);
    });
    return client;
  };
  return pipe;
}

// Runs a capture through executeBroker on the mocked clock, 250 ms per turn, until it settles.
// `at` runs once the clock has advanced that far from the first pipe attempt.
async function heldCapture(t, launchRoot, pipe, { signal, at } = {}) {
  const references = new ReferenceImages({
    launchRoot,
    startTime: async () => null,
    brokerExecutor: (processId, envelope, options) => executeBroker(processId, envelope, { ...options, connector: pipe.connector }),
  });
  t.after(() => references.closeSync());
  const started = Date.now();
  let outcome;
  references.capture({ processId: 4242, purpose: "Check the plan after the run", signal })
    .then(value => { outcome = { value }; }, error => { outcome = { error }; });
  while (!outcome) {
    await new Promise(resolve => setImmediate(resolve));
    if (at && pipe.firstAttemptAt !== null && Date.now() - pipe.firstAttemptAt >= at.ms) {
      at.run(references);
      at = null;
    }
    // Once Revit answers, the export's real file I/O must not race the mocked clock.
    if (!pipe.connected || !pipe.answer) t.mock.timers.tick(250);
  }
  return { ...outcome, pipeMs: Date.now() - (pipe.firstAttemptAt ?? started) };
}

test("a capture waits for a run's hold to end and then captures", async (t) => {
  const launchRoot = await base(t, "held");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  // Longer than the old 20 s pipe budget and the default 120 s script time limit; the whole 600 s
  // top of the setting's range; and a hold past that deadline, which the add-in checks only between
  // calls: a Revit call started at 590 s that takes 90 s, then a 60 s rollback. The 610 s wait of
  // the previous head failed that capture with EXPORT_FAILED while the hold was still active.
  for (const holdMs of [30_000, 120_000, 600_000, 590_000 + 90_000 + 60_000]) {
    const pipe = heldPipe(holdMs);
    const { value, error } = await heldCapture(t, launchRoot, pipe);
    assert.equal(error, undefined, `hold ${holdMs} ms: ${error?.message}`);
    assert.equal(pipe.served.length, 1);
    const waitedMs = pipe.served[0].at - pipe.firstAttemptAt;
    assert.ok(waitedMs >= holdMs && waitedMs < holdMs + 1_000, `hold ${holdMs} ms: served after ${waitedMs} ms`);
    assert.equal(value.metadata.captureId, pipe.served[0].envelope.id);
    assert.deepEqual(await readFile(value.absolutePath), png(64, 48));
  }
});

test("a capture behind a hold stops waiting only when cancelled or the session closes", async (t) => {
  const launchRoot = await base(t, "held-end");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });

  // A request the client cancels stops waiting then, with no export.
  const cancelled = heldPipe(Infinity);
  const controller = new AbortController();
  const stopped = await heldCapture(t, launchRoot, cancelled, {
    signal: controller.signal,
    at: { ms: 900_000, run: () => controller.abort() },
  });
  assert.equal(stopped.error?.code, "EXPORT_FAILED");
  assert.match(stopped.error.message, /cancelled while Revit was busy; no capture was taken/);
  assert.equal(cancelled.served.length, 0);
  assert.ok(stopped.pipeMs >= 900_000 && stopped.pipeMs < 901_000, `${stopped.pipeMs} ms`);

  // Shutdown ends the wait too, so a closing server does not stay alive behind a hold.
  const closing = heldPipe(Infinity);
  const shut = await heldCapture(t, launchRoot, closing, { at: { ms: 30_000, run: references => references.closeSync() } });
  assert.equal(shut.error?.code, "SESSION_CLOSING");
  assert.equal(closing.served.length, 0);

  // Once the hold ends, Revit has its own 110 s for the export, whatever the wait was.
  const silent = heldPipe(700_000, { answer: false });
  const timedOut = await heldCapture(t, launchRoot, silent);
  assert.equal(timedOut.error?.code, "EXPORT_FAILED");
  assert.match(timedOut.error.message, /timed out/);
  assert.equal(silent.served.length, 1);
  const exportMs = timedOut.pipeMs - 700_000;
  assert.ok(exportMs >= BROKER_BUDGET.timeoutMs - 500 && exportMs <= BROKER_BUDGET.timeoutMs + 500, `${exportMs} ms`);
});

test("a capture cancelled while its pipe connection is in flight sends Revit nothing", async (t) => {
  const launchRoot = await base(t, "connect-cancel");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  // One attempt whose connect stays pending until the request is cancelled; the add-in side
  // greets and records anything written to it.
  const [client, addIn] = duplexPair();
  addIn.setEncoding("utf8");
  addIn.write(`${JSON.stringify({ processId: 4242, version: "2026", build: "26.0.4.409" })}\n`);
  const written = [];
  addIn.on("data", chunk => written.push(chunk));
  const pipe = { answer: true, firstAttemptAt: null, connected: false, attempts: 0 };
  pipe.connector = () => {
    pipe.attempts += 1;
    pipe.firstAttemptAt ??= Date.now();
    return client;
  };
  const controller = new AbortController();
  const { error } = await heldCapture(t, launchRoot, pipe, {
    signal: controller.signal,
    // The connection completes the moment after the cancellation, as in a race with the add-in.
    at: { ms: 1_000, run: () => { controller.abort(); client.emit("connect"); } },
  });
  assert.equal(error?.code, "EXPORT_FAILED");
  assert.match(error.message, /cancelled while Revit was busy; no capture was taken/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(written, []);
  assert.equal(client.destroyed, true);
  assert.equal(pipe.attempts, 1);
});

test("a client that cancels capture_revit_view ends the wait for Revit", { timeout: 10_000 }, async (t) => {
  const launchRoot = await base(t, "held-cancel");
  let waiting;
  const { client, references } = await connected(t, {
    launchRoot,
    // Stands in for a pipe that stays busy: it settles only when the signal aborts.
    brokerExecutor: (processId, envelope, { signal }) => new Promise((resolve, reject) => {
      waiting = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const controller = new AbortController();
  const call = client.callTool({ name: "capture_revit_view", arguments: { purpose: "Check the floor plan" } }, undefined, { signal: controller.signal });
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.aborted, false);
  controller.abort();
  await assert.rejects(call);
  // The cancellation reaches the server as notifications/cancelled and aborts the request's signal.
  while (!waiting.aborted) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await listTree(references.sessionDirectory)).filter(name => !name.startsWith(".")), []);
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

// ---- element marks (spec #8) --------------------------------------------------------------

const LEGEND = [
  // The pipe omits nulls; the result restores every documented field.
  { mark: 1, elementId: "373532", category: "OST_Walls", familyName: "Basic Wall", typeName: "Generic - 200mm", x: 412, y: 288, bounds: { x: 380, y: 250, width: 96, height: 74 } },
  { mark: 2, elementId: "1001", x: 30, y: 300 },
];

function marksReceipt(overrides = {}) {
  return { legend: LEGEND, omitted: 4, ...overrides };
}

test("a capture without a scope sends no marks fields and returns no marks object", async (t) => {
  const launchRoot = await base(t, "nomarks");
  const envelopes = [];
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ envelopes }) });
  // There is no marks argument; an old-style marks: true is not a scope and marks nothing.
  for (const args of [{}, { marks: true }]) {
    const result = await capture(client, args);
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(result.structuredContent.marks, undefined);
    assert.doesNotMatch(result.content[1].text, /element mark|"marks"/);
    const sidecar = JSON.parse(await readFile(path.join(launchRoot, result.structuredContent.sidecarPath), "utf8"));
    assert.equal(sidecar.marks, undefined);
  }
  for (const { envelope } of envelopes) assert.deepEqual(Object.keys(envelope.capture), ["viewId", "pixelSize", "targetPath"]);
});

test("markCategories returns the scope, legend, omitted count and notes in the result and sidecar, with the same bytes", async (t) => {
  const launchRoot = await base(t, "marks");
  const envelopes = [];
  const bytes = png(90, 60, 0x40);
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ bytes, envelopes, receipt: { marks: marksReceipt() } }) });
  const result = await capture(client, { markCategories: ["OST_Walls", "OST_Doors", "OST_Walls"], viewId: "312" });
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(envelopes[0].envelope.capture.markCategories, ["OST_Walls", "OST_Doors"]);
  assert.equal(envelopes[0].envelope.capture.markElementIds, undefined);
  assert.equal(envelopes[0].envelope.capture.marks, undefined);

  const { marks } = result.structuredContent;
  assert.deepEqual(marks.scope, { categories: ["OST_Walls", "OST_Doors"], elementIds: [] });
  assert.deepEqual(marks.legend, [
    LEGEND[0],
    { mark: 2, elementId: "1001", category: null, familyName: null, typeName: null, x: 30, y: 300, bounds: null },
  ]);
  assert.equal(marks.notMarked, undefined);
  assert.equal(marks.omitted, 4);
  // A floor plan: what a missing mark means, the note for every marked capture, and both plan notes.
  const { MARK_NOTES } = await import("../server/capture.js");
  assert.deepEqual(marks.notes, [MARK_NOTES.noMark, MARK_NOTES.every, MARK_NOTES.plan, MARK_NOTES.planSymbols]);
  assert.match(result.content[1].text, /Drew 2 element marks for the requested scope; marks\.legend maps each number to its element id\. 4 more elements in the scope may be visible without a mark\. No mark does not mean no element/);

  const saved = await readFile(result.structuredContent.absolutePath);
  assert.deepEqual(saved, bytes);
  assert.deepEqual(Buffer.from(result.content[0].data, "base64"), saved);
  const sidecar = JSON.parse(await readFile(path.join(launchRoot, result.structuredContent.sidecarPath), "utf8"));
  assert.deepEqual(sidecar.marks, marks);
});

test("marks.notes always say what a missing mark means, and add the plan and 3D limits by view kind", async (t) => {
  const launchRoot = await base(t, "notes");
  let viewType = "FloorPlan";
  const brokerExecutor = async (processId, envelope, options) => fakeBroker({ receipt: { viewType, marks: marksReceipt() } })(processId, envelope, options);
  const { client } = await connected(t, { launchRoot, brokerExecutor });
  const plan = ["noMark", "every", "plan", "planSymbols"];
  const cases = [
    ["FloorPlan", ["OST_Walls"], plan], ["CeilingPlan", ["OST_Walls"], plan], ["EngineeringPlan", ["OST_Walls"], plan],
    ["FloorPlan", ["OST_Levels", "OST_Grids"], plan],
    ["ThreeD", ["OST_Walls"], ["noMark", "every", "threeD"]],
    ["ThreeD", ["OST_Walls", "OST_Levels"], ["noMark", "every", "threeD", "threeDDatums"]],
    ["ThreeD", ["OST_Grids"], ["noMark", "every", "threeD", "threeDDatums"]],
    ["Elevation", ["OST_Walls"], ["noMark", "every"]], ["Section", ["OST_Grids"], ["noMark", "every"]], ["Detail", ["OST_Walls"], ["noMark", "every"]],
  ];
  const { MARK_NOTES } = await import("../server/capture.js");
  for (const [type, markCategories, keys] of cases) {
    viewType = type;
    const result = await capture(client, { markCategories });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(result.structuredContent.marks.notes, keys.map(key => MARK_NOTES[key]), `${type} ${markCategories}`);
  }
  assert.match(MARK_NOTES.noMark, /^Marks are help in finding elements, not a list of what exists or what is visible\. An element with no mark, an empty legend, or a not_visible row may still exist and may still be in the image/);
  assert.match(MARK_NOTES.noMark, /including an element whose visibility could not be established, and those count in omitted/);
  assert.match(MARK_NOTES.planSymbols, /often a door or a window, usually gets no mark and is counted in omitted/);
  assert.match(MARK_NOTES.threeD, /transparent graphics/);
  assert.match(MARK_NOTES.threeDDatums, /Levels and grids are not marked in 3D views/);
});

test("an empty legend is a result, and still says no mark does not mean no element", async (t) => {
  const launchRoot = await base(t, "empty");
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ receipt: { viewType: "FloorPlan", marks: marksReceipt({ legend: [], omitted: 12 }) } }) });
  const result = await capture(client, { markCategories: ["OST_Doors"] });
  assert.ok(!result.isError, result.content[0].text);
  assert.ok(result.content.some(block => block.type === "image"));
  const { marks } = result.structuredContent;
  assert.deepEqual(marks.legend, []);
  assert.equal(marks.omitted, 12);
  assert.match(marks.notes[0], /^Marks are help in finding elements/);
  assert.match(result.content[1].text, /Drew 0 element marks for the requested scope.*12 more elements in the scope may be visible without a mark\. No mark does not mean no element/);
});

test("markElementIds turns marks on, de-duplicates, and returns each unmarked id with its reason", async (t) => {
  const launchRoot = await base(t, "markids");
  const envelopes = [];
  const notMarked = [
    { elementId: "9", reason: "not_found" },
    { elementId: "10", reason: "not_markable" },
    { elementId: "11", reason: "not_in_view" },
    { elementId: "12", reason: "not_visible" },
    { elementId: "13", reason: "not_placed", bounds: { x: 1, y: 2, width: 3, height: 4 } },
  ];
  const { client } = await connected(t, {
    launchRoot,
    brokerExecutor: fakeBroker({ envelopes, receipt: { viewType: "Elevation", marks: marksReceipt({ legend: [LEGEND[0]], notMarked, omitted: 0 }) } }),
  });
  const result = await capture(client, { markElementIds: ["373532", "9", "373532", "10", "11", "12", "13"] });
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(envelopes[0].envelope.capture.markElementIds, ["373532", "9", "10", "11", "12", "13"]);
  assert.equal(envelopes[0].envelope.capture.markCategories, undefined);
  const { marks } = result.structuredContent;
  assert.deepEqual(marks.scope, { categories: [], elementIds: ["373532", "9", "10", "11", "12", "13"] });
  assert.deepEqual(marks.legend, [LEGEND[0]]);
  assert.deepEqual(marks.notMarked, notMarked);
  assert.equal(marks.omitted, 0);
  const { MARK_NOTES } = await import("../server/capture.js");
  assert.deepEqual(marks.notes, [MARK_NOTES.noMark, MARK_NOTES.every]);
  assert.match(result.content[1].text, /marks\.notMarked lists 5 requested ids without a mark/);
});

test("markCategories and markElementIds together send both and echo the union's scope", async (t) => {
  const launchRoot = await base(t, "union");
  const envelopes = [];
  const { client } = await connected(t, {
    launchRoot,
    brokerExecutor: fakeBroker({ envelopes, receipt: { viewType: "Section", marks: marksReceipt({ notMarked: [] }) } }),
  });
  const result = await capture(client, { markCategories: ["OST_Walls"], markElementIds: ["373532", "1001"] });
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(envelopes[0].envelope.capture.markCategories, ["OST_Walls"]);
  assert.deepEqual(envelopes[0].envelope.capture.markElementIds, ["373532", "1001"]);
  assert.deepEqual(result.structuredContent.marks.scope, { categories: ["OST_Walls"], elementIds: ["373532", "1001"] });
  assert.deepEqual(result.structuredContent.marks.notMarked, []);
});

test("a bad category list is INVALID_MARK_CATEGORY with no Revit call and no artifact", async (t) => {
  const launchRoot = await base(t, "badcats");
  const envelopes = [];
  const { client, references } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ envelopes }) });
  const six = ["OST_Walls", "OST_Doors", "OST_Windows", "OST_Floors", "OST_Roofs", "OST_Columns"];
  for (const markCategories of [[], six, ["Doors"], ["OST Doors"], ["ost_doors"], [""], ["OST_Walls", "Walls"]]) {
    const result = await capture(client, { markCategories });
    assert.equal(result.isError, true, JSON.stringify(markCategories));
    assert.ok(!result.content.some(block => block.type === "image"));
    assert.match(result.content[0].text, /^INVALID_MARK_CATEGORY: markCategories.*No image was captured/, JSON.stringify(markCategories));
  }
  // A repeated name counts once, so five distinct names are within the limit.
  assert.equal(envelopes.length, 0);
  const five = await capture(client, { markCategories: [...six.slice(0, 5), "OST_Walls"] });
  assert.match(five.content[0].text, /^MARKS_FAILED/);
  assert.deepEqual(envelopes[0].envelope.capture.markCategories, six.slice(0, 5));
  assert.equal((await capture(client, { markCategories: [42] })).isError, true);
  assert.equal(envelopes.length, 1);
  assert.deepEqual(await listTree(path.join(launchRoot, REFERENCE_DIRECTORY, references.sessionId)), [SESSION_MARKER]);
});

test("a malformed element id is a specific error with no Revit call and no artifact", async (t) => {
  const launchRoot = await base(t, "badids");
  const envelopes = [];
  const { client, references } = await connected(t, { launchRoot, brokerExecutor: fakeBroker({ envelopes }) });
  for (const markElementIds of [["12a"], ["0"], ["-5"], ["007"], [""], ["12345678901234567890"], []]) {
    const result = await capture(client, { markElementIds });
    assert.equal(result.isError, true, JSON.stringify(markElementIds));
    assert.ok(!result.content.some(block => block.type === "image"));
    assert.match(result.content[0].text, /^INVALID_ELEMENT_ID: markElementIds.*No image was captured/, JSON.stringify(markElementIds));
  }
  // Ids are strings; a number is rejected by the argument schema.
  assert.equal((await capture(client, { markElementIds: [42] })).isError, true);
  assert.equal(envelopes.length, 0);
  assert.deepEqual(await listTree(path.join(launchRoot, REFERENCE_DIRECTORY, references.sessionId)), []);
});

test("marks failures return a specific error, no image presented as marked, and no partial artifact", async (t) => {
  const launchRoot = await base(t, "markfail");
  let mode;
  const big = Buffer.concat([png(4, 4).subarray(0, 33), Buffer.alloc(MAX_IMAGE_BYTES)]);
  const brokerExecutor = async (processId, envelope, options) => {
    if (mode === "unavailable" || mode === "drawing" || mode === "stale" || mode === "category") {
      const [code, message] = {
        unavailable: ["marks_unavailable", "Marks are unavailable for view '{3D} camera' (355099): it is a perspective 3D view."],
        drawing: ["marks_failed", "Revit exported view 'Level 1', but its marks could not be drawn: out of memory."],
        stale: ["invalid_request", "The JSON property 'markCategories' could not be mapped to any .NET member contained in type 'DriveIt.Revit.Broker.CaptureRequest'."],
        category: ["invalid_mark_category", "markCategories holds 'OST_Rooms': elements of that category are never marked."],
      }[mode];
      return { id: envelope.id, type: "view.capture", status: "failed", error: { code, message } };
    }
    const receipt = {
      missing: {},
      malformed: { marks: { legend: [{ mark: 2, elementId: "1", x: 1, y: 1 }], omitted: 0 } },
      badReason: { marks: { legend: [], notMarked: [{ elementId: "1", reason: "hidden" }], omitted: 0 } },
      big: { marks: marksReceipt() },
    }[mode];
    return fakeBroker({ bytes: mode === "big" ? big : png(32, 32), receipt })(processId, envelope, options);
  };
  const { client, references } = await connected(t, { launchRoot, brokerExecutor });
  const sessionDirectory = path.join(launchRoot, REFERENCE_DIRECTORY, references.sessionId);
  const cases = {
    unavailable: /^MARKS_UNAVAILABLE: Marks are unavailable for view .*perspective/,
    drawing: /^MARKS_FAILED: Revit exported view 'Level 1', but its marks could not be drawn/,
    stale: /^INVALID_REQUEST: .*predates element marks.*restart Revit/,
    category: /^INVALID_MARK_CATEGORY: markCategories holds 'OST_Rooms': elements of that category are never marked/,
    missing: /^MARKS_FAILED: .*no image is returned as marked/,
    malformed: /^MARKS_FAILED:/,
    badReason: /^MARKS_FAILED:/,
    big: /^CAPTURE_TOO_LARGE: The marked PNG is \d+ bytes/,
  };
  for (const [name, pattern] of Object.entries(cases)) {
    mode = name;
    const result = await capture(client, name === "badReason" ? { markElementIds: ["1"] } : { markCategories: [name === "category" ? "OST_Rooms" : "OST_Walls"] });
    assert.equal(result.isError, true, name);
    assert.ok(!result.content.some(block => block.type === "image"), name);
    assert.match(result.content[0].text, pattern, name);
    assert.match(result.content[0].text, /No image was captured/, name);
  }
  assert.deepEqual(await listTree(sessionDirectory), [SESSION_MARKER]);

  // Marks in a receipt nobody asked for are not passed off as an unmarked capture.
  mode = "big";
  const unasked = await client.callTool({ name: "capture_revit_view", arguments: { purpose: "check" } });
  assert.equal(unasked.isError, true);
});

test("discovery carries brief marks guidance beside the intact visual QA rule", async (t) => {
  const launchRoot = await base(t, "guidance");
  const { client } = await connected(t, { launchRoot, brokerExecutor: fakeBroker() });
  const { tools } = await client.listTools();
  const tool = tools.find(candidate => candidate.name === "capture_revit_view");
  for (const text of [SERVER_INSTRUCTIONS, tool.description]) {
    assert.match(text, /Element marks are optional and need a scope: pass markCategories with the categories you are working on \(up to five\), or markElementIds with the ids a run affected, or both; leave both off for a clean visual check/);
    assert.match(text, /Category names are API names as the legend returns them, such as OST_Walls/);
    assert.match(text, /marks\.legend to an elementId, API category, family, type, and the pixel bounds/);
    assert.match(text, /Marks are help, not a list of what exists: no mark, an empty legend, or not_visible does not mean the element is absent or hidden/);
    assert.match(text, /In a plan, families drawn only as symbols, often doors and windows, usually get no mark/);
    assert.match(text, /judge the model from an unmarked capture and identify elements from a marked one/);
    assert.match(text, /pass the affected element ids in markElementIds/);
    assert.match(text, /Mark numbers change between captures; carry the elementId forward/);
    assert.match(text, /Perspective 3D views do not support marks/);
    assert.match(text, /Receipts and structured checks remain the authority/);
    assert.match(text, /never claim a visual pass you did not see/);
  }
  assert.equal(tool.inputSchema.properties.marks, undefined);
  assert.equal(tool.inputSchema.properties.markCategories.type, "array");
  assert.match(tool.inputSchema.properties.markCategories.description, /^1 to 5 categories to mark, as API names the legend returns/);
  assert.equal(tool.inputSchema.properties.markElementIds.type, "array");
  assert.match(tool.inputSchema.properties.markElementIds.description, /not_found, not_markable, not_in_view, not_visible, or not_placed/);
  assert.match(tool.inputSchema.properties.markElementIds.description, /No mark never means the element is absent: not_visible means no mark could be confirmed, including an element whose visibility could not be established/);
  assert.deepEqual(tool.inputSchema.required, ["purpose"]);
  assert.ok(tool.outputSchema.properties.marks);
});
