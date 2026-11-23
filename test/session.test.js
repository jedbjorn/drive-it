import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { revitContent } from "../server/content.js";
import { listSessions, resolveProcessId } from "../server/session.js";

const session = (processId, version = "2026") => ({ processId, version, build: "b", connectionIdentity: `pipe-${processId}` });

test("an explicit processId wins and a single running Revit is used automatically", async () => {
  assert.equal(await resolveProcessId(42, { lister: async () => { throw new Error("not consulted"); } }), 42);
  assert.equal(await resolveProcessId(undefined, { lister: async () => [session(7)] }), 7);
});

test("no Revit or several Revits explain what the user must do", async () => {
  await assert.rejects(resolveProcessId(undefined, { lister: async () => [] }), error =>
    error.code === "REVIT_NOT_RUNNING" && /start Revit 2026/.test(error.message) && /Always Load/.test(error.message));
  await assert.rejects(resolveProcessId(undefined, { lister: async () => [session(7), session(9)] }), error =>
    error.code === "MULTIPLE_REVIT_SESSIONS" && /processId 7/.test(error.message) && /processId 9/.test(error.message));
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

test("Revit's installed templates, family template folders, and libraries are listed", async (t) => {
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
  assert.deepEqual(await revitContent("2027", programData), { projectTemplates: [], familyTemplateFolders: [], libraryFolders: [] });
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
