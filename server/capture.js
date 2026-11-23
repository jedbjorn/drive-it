// capture_revit_view: reference images under <launch root>/_reference-images/<session-id>.
//
// The server owns the artifact tree. It creates the session directory and an empty staging
// directory per capture, the add-in exports the view into it (Document.ExportImage in Revit's API
// context), and the server validates the PNG, hashes it, and publishes <capture-id>.png and its
// <capture-id>.json sidecar by same-directory rename. Nothing the caller supplies becomes a path.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync,
} from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { canonicalPath } from "./workspace.js";

export const REFERENCE_DIRECTORY = "_reference-images";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PIXEL_SIZE = Object.freeze({ min: 256, max: 2048, default: 1024 });
export const SIDECAR_SCHEMA = "drive-it.reference-image/1";
export const MARKER_SCHEMA = "drive-it.reference-session/1";
export const SESSION_MARKER = ".session.json";
export const EXPORT_MECHANISM = "Document.ExportImage";

const ID = "\\d{8}T\\d{6}Z-[0-9a-f]{8}";
const SESSION_ID = new RegExp(`^${ID}$`);
const STAGING = new RegExp(`^\\.tmp-(${ID})$`);
const IMAGE = new RegExp(`^(${ID})\\.png$`);
const SIDECAR = new RegExp(`^(${ID})\\.json$`);
const PARTIAL_WRITE = new RegExp(`^\\.(?:${ID}\\.json|session)\\.[0-9a-f]+\\.tmp$`);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
// Revit may round the fitted side; anything beyond this is an export larger than requested.
const PIXEL_TOLERANCE = 2;
// Worst case must stay under the 150 s tool timeout of clients such as Codex and ChatGPT
// (server/clients.js): up to 20 s queued behind another client on the pipe, then 110 s in Revit.
export const BROKER_BUDGET = Object.freeze({ connectWaitMs: 20_000, timeoutMs: 110_000 });
// A pid alive with a start time this far from the recorded one belongs to another process.
const START_TOLERANCE_MS = 10_000;

// Element ids as the add-in reads them: positive decimal, no leading zero, within a 64-bit id.
const ELEMENT_ID = /^[1-9][0-9]{0,18}$/;
const PLAN_VIEW_TYPES = new Set(["FloorPlan", "CeilingPlan", "EngineeringPlan"]);
export const NOT_MARKED_REASONS = Object.freeze(["not_found", "not_markable", "not_in_view", "not_visible", "not_placed"]);
// marks.notes: fixed sentences stating the limits that apply to a marked capture.
export const MARK_NOTES = Object.freeze({
  every: "Each mark names the element in its legend row, and bounds is the pixel rectangle of that element's visible part. Rarely a mark sits on something the image does not show; if a mark looks wrong, check the element by its id before acting.",
  plan: "In plans another element's symbol can be drawn over a marked element; the row's category and bounds say which element the mark names.",
  threeD: "In 3D views with transparent graphics a mark can sit on faint lines of an element seen through another.",
  notVisible: "not_visible also covers an element whose visibility could not be established, such as a family drawn only as a symbol in a plan, and these count in omitted; look for such an element in the image before you treat it as not drawn.",
});

export function captureError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Where reference images go: %USERPROFILE%\Drive-It (outside OneDrive-synced folders), or DRIVE_IT_LAUNCH_ROOT. */
export function launchRootFrom(env = process.env, home = homedir()) {
  const configured = env.DRIVE_IT_LAUNCH_ROOT?.trim();
  return path.resolve(configured || path.join(home, "Drive-It"));
}

/** DRIVE_IT_REFERENCE_RETENTION: session (default) or keep. Anything else falls back to session. */
export function retentionFrom(value, warn = message => console.error(message)) {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "" || mode === "session") return "session";
  if (mode === "keep") return "keep";
  warn(`drive-it: DRIVE_IT_REFERENCE_RETENTION=${JSON.stringify(value)} is not 'session' or 'keep'; using 'session'.`);
  return "session";
}

function newId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Width and height from a complete PNG: signature, IHDR first, IEND last. */
export function pngDimensions(bytes) {
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR"
    || !bytes.subarray(bytes.length - 12).equals(PNG_END)) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The ids to mark, de-duplicated in order, or null when markElementIds was not supplied. */
export function markElementIdsFrom(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw captureError("INVALID_ELEMENT_ID", "markElementIds must be a non-empty list of element ids as decimal strings, such as [\"373532\"].");
  }
  const ids = [];
  for (const [index, id] of value.entries()) {
    if (typeof id !== "string" || !ELEMENT_ID.test(id)) {
      throw captureError("INVALID_ELEMENT_ID",
        `markElementIds[${index}] is ${JSON.stringify(id)}, which is not a positive decimal Revit element id such as "373532".`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function boundsFrom(value) {
  if (value === undefined || value === null) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

/**
 * The add-in's marks receipt as the result's marks object, with every documented field present
 * (the pipe omits nulls), or null when it is not a well-formed receipt.
 */
export function marksFrom(receipt, { requested, viewType }) {
  if (!receipt || !Array.isArray(receipt.legend) || !Number.isInteger(receipt.omitted) || receipt.omitted < 0) return null;
  const legend = [];
  for (const row of receipt.legend) {
    const bounds = boundsFrom(row?.bounds);
    if (!row || !Number.isInteger(row.mark) || row.mark !== legend.length + 1 || typeof row.elementId !== "string"
      || !Number.isInteger(row.x) || !Number.isInteger(row.y) || bounds === undefined) return null;
    legend.push({
      mark: row.mark,
      elementId: row.elementId,
      category: row.category ?? null,
      familyName: row.familyName ?? null,
      typeName: row.typeName ?? null,
      x: row.x,
      y: row.y,
      bounds,
    });
  }
  const marks = { legend };
  if (requested) {
    if (!Array.isArray(receipt.notMarked)) return null;
    marks.notMarked = [];
    for (const row of receipt.notMarked) {
      const bounds = boundsFrom(row?.bounds);
      if (!row || typeof row.elementId !== "string" || !NOT_MARKED_REASONS.includes(row.reason) || bounds === undefined) return null;
      marks.notMarked.push(row.reason === "not_placed"
        ? { elementId: row.elementId, reason: row.reason, bounds }
        : { elementId: row.elementId, reason: row.reason });
    }
  }
  marks.omitted = receipt.omitted;
  marks.notes = [MARK_NOTES.every];
  if (PLAN_VIEW_TYPES.has(viewType)) marks.notes.push(MARK_NOTES.plan);
  if (viewType === "ThreeD") marks.notes.push(MARK_NOTES.threeD);
  if (marks.notMarked?.some(row => row.reason === "not_visible")) marks.notes.push(MARK_NOTES.notVisible);
  return marks;
}

function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isPlainFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Directory entries classified by lstat, never by Dirent type: on Windows a Dirent reports every
 * reparse point as a symbolic link, including OneDrive/cloud placeholders that are plain files
 * and folders. lstat reports only real links and junctions as links.
 */
function entriesOf(directory, readdir = readdirSync) {
  return readdir(directory).map(entry => {
    const name = typeof entry === "string" ? entry : entry.name;
    try {
      const stat = lstatSync(path.join(directory, name));
      return { name, link: stat.isSymbolicLink(), file: stat.isFile() && !stat.isSymbolicLink(), directory: stat.isDirectory() && !stat.isSymbolicLink() };
    } catch {
      return { name, link: false, file: false, directory: false };
    }
  });
}

/** Unlinks the plain files and links in a staging directory (never descending), then the directory. */
function clearStaging(directory, readdir = readdirSync) {
  for (const entry of entriesOf(directory, readdir)) {
    if (entry.file || entry.link) unlinkSync(path.join(directory, entry.name));
  }
  rmdirSync(directory);
}

/**
 * Removes a session directory's unretained pairs, staging directories and partial writes, then
 * the marker and directory once nothing else is left. Only names this module creates are touched;
 * an unreadable sidecar is kept, since its retention cannot be known. readdir is injectable so
 * tests can reproduce Windows' Dirent typing.
 */
export function sweepSession(directory, { readdir = readdirSync } = {}) {
  const result = { removed: [], kept: [], errors: [] };
  let entries;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
    entries = entriesOf(directory, readdir);
  } catch (error) {
    if (error.code !== "ENOENT") result.errors.push({ path: directory, message: error.message });
    return result;
  }
  const names = new Set(entries.map(entry => entry.name));
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    try {
      let match;
      if ((match = STAGING.exec(entry.name)) && entry.directory) {
        clearStaging(full, readdir);
        result.removed.push(entry.name);
      } else if ((match = SIDECAR.exec(entry.name)) && entry.file) {
        const metadata = readJsonSync(full);
        if (!metadata || metadata.captureId !== match[1] || metadata.retention?.retained !== false) {
          result.kept.push(entry.name);
          continue;
        }
        const image = path.join(directory, `${match[1]}.png`);
        if (isPlainFile(image)) {
          unlinkSync(image);
          result.removed.push(`${match[1]}.png`);
        }
        unlinkSync(full);
        result.removed.push(entry.name);
      } else if ((match = IMAGE.exec(entry.name)) && entry.file && !names.has(`${match[1]}.json`)) {
        // Published without a sidecar: an interrupted capture, never a completed pair.
        unlinkSync(full);
        result.removed.push(entry.name);
      } else if (PARTIAL_WRITE.test(entry.name) && entry.file) {
        unlinkSync(full);
        result.removed.push(entry.name);
      }
    } catch (error) {
      if (error.code !== "ENOENT") result.errors.push({ path: full, message: error.message });
    }
  }
  try {
    const rest = readdir(directory).map(entry => (typeof entry === "string" ? entry : entry.name)).filter(name => name !== SESSION_MARKER);
    if (rest.length === 0) {
      const marker = path.join(directory, SESSION_MARKER);
      if (isPlainFile(marker)) unlinkSync(marker);
      rmdirSync(directory);
      result.removedDirectory = true;
    }
  } catch (error) {
    if (error.code !== "ENOENT") result.errors.push({ path: directory, message: error.message });
  }
  return result;
}

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

/** The OS start time of a live process, or null when it cannot be read. */
export async function processStartTime(pid) {
  const output = process.platform === "win32"
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`])
    : await run("ps", ["-o", "lstart=", "-p", String(Number(pid))]);
  const time = output ? Date.parse(output) : NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * "dead" only when the owner is provably gone: same host, and either no such pid or that pid now
 * belongs to a process started at a different time. A marker from another host (a synced or
 * redirected Documents folder) or without a host is never dead. Anything uncertain is "alive"
 * and its files are left alone.
 */
export async function ownerState(marker, { startTime = processStartTime, host = hostname() } = {}) {
  const pid = marker?.processId;
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (typeof marker.hostname !== "string") return "unknown";
  if (marker.hostname.toLowerCase() !== host.toLowerCase()) return "foreign";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return "dead";
    if (error.code !== "EPERM") return "unknown";
  }
  const recorded = Date.parse(marker.processStartedAt);
  if (!Number.isFinite(recorded)) return "alive";
  const actual = await startTime(pid);
  if (actual === null) return "alive";
  return Math.abs(actual - recorded) > START_TOLERANCE_MS ? "dead" : "alive";
}

function displayPath(...segments) {
  return segments.join("/");
}

export class ReferenceImages {
  constructor({
    launchRoot = launchRootFrom(),
    retention = "session",
    brokerExecutor,
    startTime = processStartTime,
    processStart = Date.now() - process.uptime() * 1000,
    ownerInspector = ownerState,
    readdir = readdirSync,
    log = message => console.error(message),
  } = {}) {
    this.launchRoot = path.resolve(launchRoot);
    this.retention = retention;
    this.brokerExecutor = brokerExecutor;
    this.startTime = startTime;
    this.estimatedStart = processStart;
    this.ownerInspector = ownerInspector;
    this.readdir = readdir;
    this.log = log;
    this.sessionId = newId();
    this.sessionDirectory = path.join(this.launchRoot, REFERENCE_DIRECTORY, this.sessionId);
    this.sessionCreated = false;
    this.directoryMade = false;
    this.closed = false;
  }

  /**
   * This process's start time as the OS reports it, the same source the stale sweep compares
   * against; the uptime-based estimate only when the OS cannot be asked.
   */
  async ownStart() {
    this.ownStartPromise ||= Promise.resolve(this.startTime(process.pid)).catch(() => null).then(actual => (
      actual === null
        ? { processStartedAt: new Date(this.estimatedStart).toISOString(), processStartSource: "estimate" }
        : { processStartedAt: new Date(actual).toISOString(), processStartSource: "os" }));
    return this.ownStartPromise;
  }

  /** Creates or re-checks a directory that must be a real directory at exactly the expected place. */
  async ownedDirectory(directory, expectedReal, { create, exclusive = false }) {
    if (create) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (error.code !== "EEXIST" || exclusive) throw error;
      }
    }
    const stat = await lstat(directory);
    const actual = stat.isSymbolicLink() || !stat.isDirectory() ? null : await realpath(directory);
    if (!actual || !samePath(actual, expectedReal)) {
      throw captureError("REFERENCE_DIRECTORY_LINKED",
        `${directory} is a link, junction, or file rather than a directory Drive It owns; remove it so captures stay under the launch root.`,
        { stage: "store" });
    }
    return actual;
  }

  async referenceRoot() {
    await mkdir(this.launchRoot, { recursive: true });
    const root = await realpath(this.launchRoot);
    const directory = path.join(this.launchRoot, REFERENCE_DIRECTORY);
    return this.ownedDirectory(directory, path.join(root, REFERENCE_DIRECTORY), { create: true });
  }

  async ensureSession() {
    for (let attempt = 0; ; attempt += 1) {
      // Concurrent first captures share one creation.
      this.creating ||= this.createSession().catch(error => {
        this.creating = null;
        throw error;
      });
      const references = await this.creating;
      try {
        await this.ownedDirectory(this.sessionDirectory, path.join(references, this.sessionId), { create: false });
        return this.sessionDirectory;
      } catch (error) {
        // The user removed the session folder (or _reference-images) mid-session: start it again.
        if (error.code !== "ENOENT" || attempt >= 1) throw error;
        this.creating = null;
        this.sessionCreated = false;
        this.directoryMade = false;
      }
    }
  }

  async createSession() {
    const references = await this.referenceRoot();
    if (!this.sessionCreated) {
      const expected = path.join(references, this.sessionId);
      try {
        // A folder this instance already made (an earlier marker write failed) is reused.
        await this.ownedDirectory(this.sessionDirectory, expected, { create: true, exclusive: !this.directoryMade });
        this.directoryMade = true;
        await this.writeAtomic(path.join(this.sessionDirectory, SESSION_MARKER), {
          schema: MARKER_SCHEMA,
          sessionId: this.sessionId,
          hostname: hostname(),
          processId: process.pid,
          ...await this.ownStart(),
          createdAt: new Date().toISOString(),
          retentionMode: this.retention,
        }, `.session.${randomBytes(4).toString("hex")}.tmp`);
      } catch (error) {
        // Without a marker no sweep would ever own the folder; remove it while it is empty.
        if (this.directoryMade) {
          try {
            rmdirSync(this.sessionDirectory);
            this.directoryMade = false;
          } catch {
            // Not empty or locked; the next attempt reuses it.
          }
        }
        throw error;
      }
      this.sessionCreated = true;
    }
    return references;
  }

  async writeAtomic(file, value, temporaryName) {
    const temporary = path.join(path.dirname(file), temporaryName);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  retentionFor(requested) {
    const retained = this.retention === "keep" || requested === true;
    return { mode: this.retention, requested: requested === true, retained, survivesSessionEnd: retained };
  }

  async capture({
    processId, document, viewId, pixelSize = PIXEL_SIZE.default, purpose, relatedRunIds = [], retain = false,
    marks = false, markElementIds,
  }) {
    if (this.closed) throw captureError("SESSION_CLOSING", "This MCP session is shutting down; no capture was taken.");
    if (!Number.isInteger(pixelSize) || pixelSize < PIXEL_SIZE.min || pixelSize > PIXEL_SIZE.max) {
      throw captureError("INVALID_PIXEL_SIZE", `pixelSize must be an integer from ${PIXEL_SIZE.min} through ${PIXEL_SIZE.max}.`);
    }
    // Supplying markElementIds turns marks on and limits them to those elements.
    const markIds = markElementIdsFrom(markElementIds);
    const marked = marks === true || markIds !== null;
    let directory;
    try {
      directory = await this.ensureSession();
    } catch (error) {
      if (error.code === "REFERENCE_DIRECTORY_LINKED") throw error;
      throw captureError("ARTIFACT_WRITE_FAILED", `Could not create the reference-image directory under ${this.launchRoot}: ${error.message}`, { stage: "store" });
    }
    // Shutdown may have started while the folder was being prepared; ask Revit for nothing then.
    if (this.closed) throw captureError("SESSION_CLOSING", "This MCP session is shutting down; no capture was taken.");

    let captureId;
    let staging;
    for (let attempt = 0; ; attempt += 1) {
      captureId = newId();
      staging = path.join(directory, `.tmp-${captureId}`);
      try {
        await mkdir(staging);
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || attempt >= 4) {
          throw captureError("ARTIFACT_WRITE_FAILED", `Could not create a capture staging directory: ${error.message}`, { stage: "store" });
        }
      }
    }

    const imageName = `${captureId}.png`;
    const image = path.join(directory, imageName);
    const sidecar = path.join(directory, `${captureId}.json`);
    let published = false;
    try {
      const target = path.join(staging, imageName);
      const documentPath = document?.path ? await canonicalPath(document.path) : null;
      const envelope = {
        id: captureId,
        type: "view.capture",
        document: document ? { path: documentPath, uniqueId: document.uniqueId || null } : null,
        capture: { viewId: viewId ?? null, pixelSize, targetPath: target },
      };
      // Only a marks request carries marks fields, so a capture without them is unchanged.
      if (marked) {
        envelope.capture.marks = true;
        if (markIds) envelope.capture.markElementIds = markIds;
      }
      // The Revit version and build come from the pipe greeting of this same connection, so no
      // second connection competes for the single-instance pipe.
      let session = null;
      let response;
      try {
        response = await this.brokerExecutor(processId, envelope, {
          ...BROKER_BUDGET,
          onSession: value => { session = value; },
        });
      } catch (error) {
        throw captureError("EXPORT_FAILED", `The capture did not complete in Revit: ${error.message}`, { stage: "export" });
      }
      if (this.closed) throw captureError("SESSION_CLOSING", "This MCP session is shutting down; the capture was discarded.", { stage: "export" });
      if (response?.status !== "succeeded") {
        const code = String(response?.error?.code || "export_failed").toUpperCase();
        let message = response?.error?.message || "Revit did not export the view.";
        if (code === "UNSUPPORTED_REQUEST") {
          message += " The Drive-It add-in loaded in Revit predates view capture (Drive-It was updated while Revit was running); ask the user to restart Revit.";
        } else if (marked && code === "INVALID_REQUEST" && /could not be mapped/i.test(message) && /mark/i.test(message)) {
          message += " The Drive-It add-in loaded in Revit predates element marks (Drive-It was updated while Revit was running); ask the user to restart Revit, or capture without marks.";
        }
        const detail = { stage: "export" };
        if (response?.document) detail.document = response.document;
        const lists = response?.capture || {};
        if (lists.availableViews) detail.availableViews = lists.availableViews;
        if (lists.otherViews?.length) detail.otherViews = lists.otherViews;
        for (const key of ["availableViewsTotal", "otherViewsTotal", "viewsListedPerType", "otherViewsListedPerType"]) {
          if (lists[key] !== undefined && lists[key] !== null) detail[key] = lists[key];
        }
        throw captureError(code, message, detail);
      }
      const receipt = response.capture || {};
      if (receipt.documentModifiedBefore === false && receipt.documentModifiedAfter === true) {
        throw captureError("DOCUMENT_MODIFIED_BY_CAPTURE",
          "Revit reports that the document became modified during the export. No image is returned; tell the user the document now has unsaved changes Drive It did not intend.",
          { stage: "export", document: response.document ?? null });
      }
      if (receipt.outputPath && !samePath(receipt.outputPath, target)) {
        throw captureError("INVALID_IMAGE", "Revit reported an export path other than the requested target.", { stage: "validate" });
      }

      let stat;
      try {
        stat = await lstat(target);
      } catch {
        throw captureError("INVALID_IMAGE", "Revit reported success but the exported PNG is missing.", { stage: "validate" });
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw captureError("INVALID_IMAGE", "The exported image is not a plain file.", { stage: "validate" });
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        throw captureError("CAPTURE_TOO_LARGE",
          `The ${marked ? "marked" : "exported"} PNG is ${stat.size} bytes, over the ${MAX_IMAGE_BYTES}-byte (8 MiB) limit. Retry with a smaller pixelSize.`,
          { stage: "validate", byteSize: stat.size, pixelSize });
      }
      const bytes = await readFile(target);
      const dimensions = pngDimensions(bytes);
      if (!dimensions || bytes.length !== stat.size) {
        throw captureError("INVALID_IMAGE", "The exported file is not a complete PNG image.", { stage: "validate" });
      }
      if (Math.max(dimensions.width, dimensions.height) > pixelSize + PIXEL_TOLERANCE) {
        throw captureError("CAPTURE_SIZE_EXCEEDED",
          `Revit exported ${dimensions.width}x${dimensions.height}, larger than the requested pixelSize ${pixelSize} on its longer side.`,
          { stage: "validate", width: dimensions.width, height: dimensions.height, pixelSize });
      }
      let markResult = null;
      if (marked) {
        markResult = marksFrom(receipt.marks, { requested: markIds !== null, viewType: receipt.viewType });
        if (!markResult) {
          throw captureError("MARKS_FAILED", "Revit exported the view but returned no usable marks legend; no image is returned as marked.", { stage: "validate" });
        }
      } else if (receipt.marks !== undefined && receipt.marks !== null) {
        throw captureError("INVALID_IMAGE", "Revit returned marks for a capture that did not ask for them.", { stage: "validate" });
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const retention = this.retentionFor(retain);
      const metadata = {
        schema: SIDECAR_SCHEMA,
        captureId,
        sessionId: this.sessionId,
        createdAt: new Date().toISOString(),
        purpose,
        relatedRunIds,
        retention,
        image: {
          path: displayPath(REFERENCE_DIRECTORY, this.sessionId, imageName),
          mimeType: "image/png",
          sha256,
          byteSize: bytes.length,
          width: dimensions.width,
          height: dimensions.height,
        },
        revit: { processId, version: session?.version ?? null, build: session?.build ?? null },
        document: {
          uniqueId: response.document?.uniqueId ?? null,
          title: response.document?.title ?? null,
          path: response.document?.path ?? null,
          kind: response.document?.kind ?? null,
        },
        view: {
          id: receipt.viewId ?? null,
          uniqueId: receipt.viewUniqueId ?? null,
          name: receipt.viewName ?? null,
          type: receipt.viewType ?? null,
        },
        export: {
          mechanism: EXPORT_MECHANISM,
          requestedPixelSize: pixelSize,
          fitDirection: receipt.fitDirection ?? null,
          temporaryViewCreated: receipt.temporaryViewCreated === true,
          transactionStarted: receipt.transactionStarted === true,
          documentModifiedBefore: receipt.documentModifiedBefore ?? null,
          documentModifiedAfter: receipt.documentModifiedAfter ?? null,
        },
      };
      if (markResult) metadata.marks = markResult;

      if (this.closed) throw captureError("SESSION_CLOSING", "This MCP session is shutting down; the capture was discarded.", { stage: "store" });
      try {
        await rename(target, image);
        published = true;
        await this.writeAtomic(sidecar, metadata, `.${captureId}.json.${randomBytes(4).toString("hex")}.tmp`);
      } catch (error) {
        throw captureError("ARTIFACT_WRITE_FAILED", `The image was exported but could not be saved: ${error.message}`, { stage: "store" });
      }
      if (this.closed) throw captureError("SESSION_CLOSING", "This MCP session is shutting down; the capture was discarded.", { stage: "store" });
      published = false;
      return { metadata, bytes, absolutePath: image, sidecarPath: sidecar };
    } catch (error) {
      if (published) {
        await unlink(image).catch(() => {});
        await unlink(sidecar).catch(() => {});
      }
      throw error;
    } finally {
      try {
        clearStaging(staging, this.readdir);
      } catch (error) {
        if (error.code !== "ENOENT") this.log(`drive-it: could not remove capture staging ${staging}: ${error.message}`);
      }
    }
  }

  /** Normal shutdown: removes this session's unretained pairs and, once empty, its directory. */
  closeSync() {
    this.closed = true;
    if (!this.sessionCreated) return null;
    const result = sweepSession(this.sessionDirectory, { readdir: this.readdir });
    for (const error of result.errors) this.log(`drive-it: reference-image cleanup failed for ${error.path}: ${error.message}`);
    return result;
  }

  /** Startup: sweeps sessions under this launch root whose owning process is provably gone. */
  async cleanupStaleSessions() {
    const references = path.join(this.launchRoot, REFERENCE_DIRECTORY);
    let entries;
    try {
      const root = await realpath(this.launchRoot);
      await this.ownedDirectory(references, path.join(root, REFERENCE_DIRECTORY), { create: false });
      entries = entriesOf(references, this.readdir);
    } catch (error) {
      if (error.code !== "ENOENT") this.log(`drive-it: skipped stale reference-image cleanup: ${error.message}`);
      return [];
    }
    const swept = [];
    for (const entry of entries) {
      if (!entry.directory || !SESSION_ID.test(entry.name) || entry.name === this.sessionId) continue;
      const directory = path.join(references, entry.name);
      const marker = readJsonSync(path.join(directory, SESSION_MARKER));
      if (marker?.schema !== MARKER_SCHEMA || marker.sessionId !== entry.name) continue;
      if (await this.ownerInspector(marker) !== "dead") continue;
      const result = sweepSession(directory, { readdir: this.readdir });
      for (const error of result.errors) this.log(`drive-it: stale reference-image cleanup failed for ${error.path}: ${error.message}`);
      swept.push({ sessionId: entry.name, ...result });
    }
    return swept;
  }
}
