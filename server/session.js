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
