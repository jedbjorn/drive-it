import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { revitContent, revitContentFolders } from "../server/content.js";
import { EventEmitter } from "node:events";
import { listSessions, openPipe, resolveProcessId } from "../server/session.js";

const session = (processId, version = "2026") => ({ processId, version, build: "b", connectionIdentity: `pipe-${processId}` });

test("an explicit processId wins and a single running Revit is used automatically", async () => {
  assert.equal(await resolveProcessId(42, { lister: async () => { throw new Error("not consulted"); } }), 42);
  assert.equal(await resolveProcessId(undefined, { lister: async () => [session(7)] }), 7);
});

test("no Revit or several Revits explain what the user must do", async () => {
  await assert.rejects(resolveProcessId(undefined, { lister: async () => [] }), error =>
    error.code === "REVIT_NOT_RUNNING" && /^No running Revit 2026 or 2027 /.test(error.message)
    && /start Revit 2026 or 2027 /.test(error.message) && /Always Load/.test(error.message));
  await assert.rejects(resolveProcessId(undefined, { lister: async () => [session(7), session(9)] }), error =>
    error.code === "MULTIPLE_REVIT_SESSIONS" && /processId 7/.test(error.message) && /processId 9/.test(error.message));
});

test("Revit 2026 and 2027 sessions are listed side by side with their versions", async () => {
  const sessions = await listSessions({
    pipeLister: async () => ["drive-it-7", "drive-it-9"],
    reader: async processId => session(processId, processId === 7 ? "2026" : "2027"),
  });
  assert.deepEqual(sessions.map(row => [row.processId, row.version]).sort(), [[7, "2026"], [9, "2027"]]);
  await assert.rejects(resolveProcessId(undefined, { lister: async () => sessions }), error =>
    error.code === "MULTIPLE_REVIT_SESSIONS" && /processId 7 \(Revit 2026\)/.test(error.message) && /processId 9 \(Revit 2027\)/.test(error.message));
});

test("session listing reads only drive-it pipes and skips stale ones", async () => {
  const seen = [];
  const sessions = await listSessions({
    pipeLister: async () => ["other-pipe", "drive-it-7", "drive-it-9", "drive-it-x"],
    reader: async processId => {
      seen.push(processId);
      if (processId === 9) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return session(processId);
    },
  });
  assert.deepEqual(seen.sort(), [7, 9]);
  assert.deepEqual(sessions.map(row => row.processId), [7]);
});

test("Revit's installed templates, family template folders, and libraries are listed for the session's version", async (t) => {
  const programData = await mkdtemp(path.join(tmpdir(), "drive-it-content-"));
  t.after(() => rm(programData, { recursive: true, force: true }));
  const root = path.join(programData, "Autodesk", "RVT 2026");
  await mkdir(path.join(root, "Templates", "English-Imperial"), { recursive: true });
  await mkdir(path.join(root, "Family Templates", "English-Imperial"), { recursive: true });
  await mkdir(path.join(root, "Libraries", "English-Imperial"), { recursive: true });
  await writeFile(path.join(root, "Templates", "English-Imperial", "default.rte"), "");
  await writeFile(path.join(root, "Templates", "English-Imperial", "notes.txt"), "");

  assert.deepEqual(await revitContent("2026", programData), {
    projectTemplates: [path.join(root, "Templates", "English-Imperial", "default.rte")],
    familyTemplateFolders: [path.join(root, "Family Templates", "English-Imperial")],
    libraryFolders: [path.join(root, "Libraries", "English-Imperial")],
  });
  const empty = { projectTemplates: [], familyTemplateFolders: [], libraryFolders: [] };
  assert.deepEqual(await revitContent("2027", programData), empty);

  const root2027 = path.join(programData, "Autodesk", "RVT 2027");
  await mkdir(path.join(root2027, "Templates", "English"), { recursive: true });
  await writeFile(path.join(root2027, "Templates", "English", "default.rte"), "");
  assert.deepEqual((await revitContent("2027", programData)).projectTemplates, [path.join(root2027, "Templates", "English", "default.rte")]);
  assert.deepEqual(revitContentFolders("2027", programData), ["Templates", "Family Templates", "Libraries"].map(name => path.join(root2027, name)));
  // No session version, no content: never a fixed year's folders.
  assert.deepEqual(await revitContent(undefined, programData), empty);
  assert.deepEqual(revitContentFolders(null, programData), []);
});

test("back-to-back reads ride out the add-in re-creating its pipe", { skip: process.platform !== "win32" }, async (t) => {
  const { createServer } = await import("node:net");
  const { readSession } = await import("../server/session.js");
  const processId = 40000 + (process.pid % 20000);
  const info = { processId, version: "2026", build: "test" };
  let server;
  let closed = false;
  // Like the add-in: one connection per pipe instance, and a gap before the next instance exists.
  const listen = () => {
    if (closed) return;
    server = createServer(socket => {
      socket.end(`${JSON.stringify(info)}\n`);
      server.close(() => setTimeout(listen, 40));
    });
    server.listen(String.raw`\\.\pipe\drive-it-${processId}`);
  };
  listen();
  t.after(() => { closed = true; server.close(); });
  await new Promise(resolve => setTimeout(resolve, 50));

  const first = await readSession(processId);
  const second = await readSession(processId);
  assert.equal(first.processId, processId);
  assert.equal(second.processId, processId);
});

// A connector that fails with the given codes in order, then connects.
function scriptedConnector(codes) {
  const calls = [];
  const connector = name => {
    calls.push(name);
    const pipe = new EventEmitter();
    pipe.destroy = () => {};
    const code = codes.shift();
    setImmediate(() => (code ? pipe.emit("error", Object.assign(new Error(code), { code })) : pipe.emit("connect")));
    return pipe;
  };
  return { connector, calls };
}

test("a busy pipe is waited on for connectWaitMs; an absent one only briefly", async () => {
  const busy = Array(20).fill("EBUSY");
  const waited = scriptedConnector([...busy]);
  await openPipe(1, { waitMs: 30_000, connector: waited.connector });
  assert.equal(waited.calls.length, 21);

  const impatient = scriptedConnector([...busy]);
  await assert.rejects(openPipe(1, { connector: impatient.connector }), { code: "EBUSY" });
  assert.equal(impatient.calls.length, 8);

  // The gap between pipe instances (ENOENT) while queued does not end the wait.
  const queued = scriptedConnector(["EBUSY", "EBUSY", "ENOENT", ...Array(12).fill("EBUSY"), "ENOENT", "ENOENT"]);
  await openPipe(1, { waitMs: 30_000, connector: queued.connector });
  assert.equal(queued.calls.length, 18);

  // A pipe that stays absent means Revit is gone, however long the caller would wait.
  const gone = scriptedConnector(Array(20).fill("ENOENT"));
  const started = Date.now();
  await assert.rejects(openPipe(1, { waitMs: 30_000, connector: gone.connector }), { code: "ENOENT" });
  assert.equal(gone.calls.length, 8);
  assert.ok(Date.now() - started < 5_000);

  const refused = scriptedConnector(["EACCES"]);
  await assert.rejects(openPipe(1, { waitMs: 30_000, connector: refused.connector }), { code: "EACCES" });
  assert.equal(refused.calls.length, 1);
});

test("a Revit busy serving another client is still found", async () => {
  const reader = async processId => {
    if (processId === 7) throw Object.assign(new Error("connect EBUSY"), { code: "EBUSY" });
    throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
  };
  const sessions = await listSessions({ pipeLister: async () => ["drive-it-7", "drive-it-9"], reader });
  assert.deepEqual(sessions, [{ processId: 7, version: null, build: null, busy: true }]);
  assert.equal(await resolveProcessId(undefined, { lister: async () => sessions }), 7);
  await assert.rejects(resolveProcessId(undefined, { lister: async () => [...sessions, session(9)] }), error =>
    /processId 7 \(busy\)/.test(error.message) && /processId 9 \(Revit 2026\)/.test(error.message));
});
