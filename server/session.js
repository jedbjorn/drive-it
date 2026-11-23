import { createConnection } from "node:net";
import { z } from "zod";

const sessionSchema = z.object({
  processId: z.number().int().positive(),
  version: z.string(),
  build: z.string(),
});

function pipeName(processId) {
  return String.raw`\\.\pipe\drive-it-${processId}`;
}

function connect(processId, timeoutMs) {
  if (process.platform !== "win32") {
    throw new Error("Run the MCP server on the Windows machine hosting Revit.");
  }
  const pipe = createConnection(pipeName(processId));
  pipe.setEncoding("utf8");
  const iterator = pipe[Symbol.asyncIterator]();
  let buffered = "";
  const timeout = setTimeout(() => pipe.destroy(new Error("Revit connection timed out.")), timeoutMs);

  async function readJson(maxBytes) {
    while (!buffered.includes("\n")) {
      const { value, done } = await iterator.next();
      if (done) throw new Error("Revit disconnected before sending a complete response.");
      buffered += value;
      if (buffered.length > maxBytes) throw new Error("Revit response is too large.");
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    return JSON.parse(line);
  }

  return {
    readJson,
    writeJson(value) {
      return new Promise((resolve, reject) => pipe.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()));
    },
    close() {
      clearTimeout(timeout);
      pipe.destroy();
    },
  };
}

function validateSession(info, processId) {
  const session = sessionSchema.parse(info);
  if (session.processId !== processId) throw new Error("Unexpected Revit process ID.");
  return { ...session, connectionIdentity: `current-user:named-pipe:drive-it-${processId}` };
}

export async function readSession(processId, { timeoutMs = 4000 } = {}) {
  const connection = connect(processId, timeoutMs);
  try {
    return validateSession(await connection.readJson(4096), processId);
  } finally {
    connection.close();
  }
}

export async function executeBroker(processId, envelope, { timeoutMs = 30000 } = {}) {
  const connection = connect(processId, timeoutMs);
  try {
    validateSession(await connection.readJson(4096), processId);
    await connection.writeJson(envelope);
    const response = await connection.readJson(10 * 1024 * 1024);
    if (response.id !== envelope.id) throw new Error("Revit broker response did not match the run ID.");
    return response;
  } finally {
    connection.close();
  }
}

export function sessionError(error) {
  return error.code === "ENOENT"
    ? "Check the Revit process ID and that the Drive It add-in is loaded."
    : error.message;
}

const SESSION_PIPE = /^drive-it-(\d+)$/;

async function listPipes() {
  if (process.platform !== "win32") return [];
  const { readdir } = await import("node:fs/promises");
  return readdir("\\\\.\\pipe\\");
}

// Every Revit with the add-in loaded serves drive-it-<pid>; stale or busy pipes are skipped.
export async function listSessions({ pipeLister = listPipes, reader = readSession } = {}) {
  const ids = (await pipeLister()).map(name => SESSION_PIPE.exec(name)?.[1]).filter(Boolean).map(Number);
  const sessions = await Promise.all(ids.map(id => reader(id, { timeoutMs: 2000 }).catch(() => null)));
  return sessions.filter(Boolean);
}

function sessionLookupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// An explicit processId wins; otherwise the only running session is used.
export async function resolveProcessId(processId, { lister = listSessions } = {}) {
  if (processId !== undefined) return processId;
  const sessions = await lister();
  if (sessions.length === 1) return sessions[0].processId;
  if (sessions.length === 0) {
    throw sessionLookupError("REVIT_NOT_RUNNING", "No running Revit 2026 has the Drive It add-in loaded. Ask the user to start Revit 2026 and, if Revit asks about Drive It, to choose Always Load; then try again.");
  }
  const list = sessions.map(session => `processId ${session.processId} (Revit ${session.version})`).join(", ");
  throw sessionLookupError("MULTIPLE_REVIT_SESSIONS", `Several Revit sessions are running: ${list}. Ask the user which Revit window to use and pass its processId.`);
}
