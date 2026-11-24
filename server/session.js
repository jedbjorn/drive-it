import { createConnection } from "node:net";
import { z } from "zod";

// The Revit versions Drive-It supports, one add-in build each (spec #22; installer/Build-DriveItPackage.ps1).
// Text that cannot know the session's version names them all.
export const REVIT_VERSIONS = ["2026", "2027"];
export const REVIT_VERSION_NAMES = `${REVIT_VERSIONS.slice(0, -1).join(", ")} or ${REVIT_VERSIONS.at(-1)}`;

const sessionSchema = z.object({
  processId: z.number().int().positive(),
  version: z.string(),
  build: z.string(),
});

function pipeName(processId) {
  return String.raw`\\.\pipe\drive-it-${processId}`;
}

// The add-in serves one connection at a time and re-creates its pipe after each one. While it
// serves another client the pipe answers EBUSY; in the moment between instances it is absent
// (ENOENT). ENOENT gets a short budget of `attempts` consecutive retries, since a pipe that stays
// absent means Revit is gone. EBUSY is retried for `waitMs` (at least `attempts` times), for
// callers that may queue behind another client's slow request; with waitMs Infinity, until the
// pipe frees or `signal` aborts.
export async function openPipe(processId, { attempts = 8, waitMs = 0, signal, connector = createConnection } = {}) {
  const deadline = Date.now() + waitMs;
  let busy = 0;
  let absent = 0;
  for (;;) {
    signal?.throwIfAborted();
    const pipe = connector(pipeName(processId));
    let aborted;
    try {
      await new Promise((resolve, reject) => {
        pipe.once("connect", resolve);
        pipe.once("error", reject);
        // A cancelled caller stops waiting on an in-flight attempt too, not just between attempts.
        aborted = () => reject(signal.reason);
        signal?.addEventListener("abort", aborted, { once: true });
      });
      // A pipe that connected as the signal aborted is not handed back to write through.
      signal?.throwIfAborted();
      return pipe;
    } catch (error) {
      pipe.destroy();
      if (signal?.aborted) throw signal.reason;
      if (error.code === "EBUSY") {
        busy += 1;
        absent = 0;
        if (busy >= attempts && Date.now() >= deadline) throw error;
      } else if (error.code === "ENOENT") {
        absent += 1;
        if (absent >= attempts) throw error;
      } else {
        throw error;
      }
    } finally {
      signal?.removeEventListener("abort", aborted);
    }
    await pause(Math.min(25 * (busy + absent), 250), signal);
  }
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

// timeoutMs runs from the connection, after any wait for the pipe.
async function connect(processId, timeoutMs, { connectWaitMs = 0, signal, connector } = {}) {
  if (!connector && process.platform !== "win32") {
    throw new Error("Run the MCP server on the Windows machine hosting Revit.");
  }
  const pipe = await openPipe(processId, { waitMs: connectWaitMs, signal, connector });
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

export async function readSession(processId, { timeoutMs = 4000, connectWaitMs = 0 } = {}) {
  const connection = await connect(processId, timeoutMs, { connectWaitMs });
  try {
    return validateSession(await connection.readJson(4096), processId);
  } finally {
    connection.close();
  }
}

export async function executeBroker(processId, envelope, { timeoutMs = 30000, connectWaitMs = 0, signal, connector, onSession } = {}) {
  const connection = await connect(processId, timeoutMs, { connectWaitMs, signal, connector });
  try {
    const session = validateSession(await connection.readJson(4096), processId);
    onSession?.(session);
    // Nothing reaches Revit once the caller has cancelled, however late in the connection.
    signal?.throwIfAborted();
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

// Every Revit with the add-in loaded serves drive-it-<pid>. A pipe busy serving another client
// is a live session whose version is unknown for now; other failures (stale pipes) are skipped.
export async function listSessions({ pipeLister = listPipes, reader = readSession } = {}) {
  const ids = (await pipeLister()).map(name => SESSION_PIPE.exec(name)?.[1]).filter(Boolean).map(Number);
  const sessions = await Promise.all(ids.map(id => reader(id, { timeoutMs: 2000 }).catch(error => (
    error.code === "EBUSY" ? { processId: id, version: null, build: null, busy: true } : null))));
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
    throw sessionLookupError("REVIT_NOT_RUNNING", `No running Revit ${REVIT_VERSION_NAMES} has the Drive It add-in loaded. Ask the user to start Revit ${REVIT_VERSION_NAMES} and, if Revit asks about Drive It, to choose Always Load; then try again.`);
  }
  const list = sessions.map(session => `processId ${session.processId} (${session.version ? `Revit ${session.version}` : "busy"})`).join(", ");
  throw sessionLookupError("MULTIPLE_REVIT_SESSIONS", `Several Revit sessions are running: ${list}. Ask the user which Revit window to use and pass its processId.`);
}

function holdError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Newline-framed replies on one long-lived pipe connection. next() resolves null once the add-in closes it.
function lineReader(pipe, maxBytes) {
  let buffered = "";
  let closed = false;
  const waiting = [];
  function drain() {
    while (waiting.length) {
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        waiting.shift().resolve(line);
      } else if (closed) {
        waiting.shift().resolve(null);
      } else {
        return;
      }
    }
  }
  pipe.on("data", chunk => {
    buffered += chunk;
    if (buffered.length > maxBytes) pipe.destroy(new Error("Revit response is too large."));
    drain();
  });
  pipe.on("close", () => {
    closed = true;
    drain();
  });
  pipe.on("error", () => {});
  return { next: () => new Promise(resolve => { waiting.push({ resolve }); drain(); }) };
}

// The outcome of a hold the add-in has ended, read without Revit's thread.
export async function readHoldResult(processId, runId, { timeoutMs = 4000, connectWaitMs = 2000 } = {}) {
  const connection = await connect(processId, timeoutMs, { connectWaitMs });
  try {
    validateSession(await connection.readJson(4096), processId);
    await connection.writeJson({ id: runId, type: "hold.result" });
    const response = await connection.readJson(1024 * 1024);
    if (response.status !== "ended") throw holdError("HOLD_RESULT_UNKNOWN", `Revit has no ended hold for run ${runId} (${response.status}).`);
    return response.hold;
  } finally {
    connection.close();
  }
}

// A run's hold: one pipe connection kept from the run's first bridge call to its end. While it is open the
// add-in serves nothing else, so other clients wait (EBUSY) as they wait behind any Revit work.
export async function openHold(processId, { runId, displayName, timeLimitMs, dryRun = false, requireDryRun = null, waitMs = timeLimitMs, resultReader = readHoldResult } = {}) {
  if (process.platform !== "win32") {
    throw new Error("Run the MCP server on the Windows machine hosting Revit.");
  }
  const pipe = await openPipe(processId, { waitMs });
  pipe.setEncoding("utf8");
  const lines = lineReader(pipe, 10 * 1024 * 1024);
  // Revit may be busy before it can enter the hold; the run's own time bounds the wait.
  const timer = setTimeout(() => pipe.destroy(), Math.max(1, timeLimitMs));
  try {
    const session = await lines.next();
    if (session === null) throw holdError("HOLD_LOST", "Revit closed the connection before the hold began.");
    validateSession(JSON.parse(session), processId);
    // A dry run's hold says so, for the status window and its refusals (spec #13 "How It Works"). Only a dry run
    // sends the flag: an add-in from before dry runs refuses a hold with a member it does not know, so a real run's
    // hold.begin stays as it was and only a dry run fails closed against an old add-in.
    // Likewise Require dry run (spec #13), sent only while it is on: { rehearsed } for the add-in's refusals.
    const hold = { displayName: displayName ?? null, timeLimitMs, ...(dryRun ? { dryRun: true } : {}), ...(requireDryRun ? { requireDryRun } : {}) };
    pipe.write(`${JSON.stringify({ id: runId, type: "hold.begin", hold })}\n`);
    const reply = await lines.next();
    if (reply === null) throw holdError("HOLD_LOST", "Revit closed the connection before the hold began.");
    const begun = JSON.parse(reply);
    if (begun.status !== "held") throw holdError(begun.error?.code || "HOLD_REFUSED", begun.error?.message || "Revit did not hold the run.");
    return new HoldConnection({ pipe, lines, processId, runId, begun: begun.hold, resultReader });
  } catch (error) {
    pipe.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class HoldConnection {
  constructor({ pipe, lines, processId, runId, begun, resultReader }) {
    Object.assign(this, { pipe, lines, processId, runId, begun, resultReader });
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closing = false;
    this.lost = false;
    this.listeners = [];
    this.ending = null;
    pipe.on("close", () => {
      if (this.closing) return;
      this.lost = true;
      for (const listener of this.listeners.splice(0)) listener();
    });
  }

  // Called once if the add-in ends the hold on its own (deadline, Stop, or Revit closing).
  onLost(listener) {
    if (this.lost) queueMicrotask(listener);
    else this.listeners.push(listener);
  }

  // One request at a time on the held connection; the reply is the add-in's response object.
  send(message) {
    const result = this.queue.then(async () => {
      if (this.lost) throw holdError("HOLD_LOST", "Revit is no longer held for this run.");
      const id = `${this.runId}:${++this.sequence}`;
      this.pipe.write(`${JSON.stringify({ ...message, id: message.type === "model.execute" ? message.id : id })}\n`);
      const line = await this.lines.next();
      if (line === null) throw holdError("HOLD_LOST", "Revit is no longer held for this run.");
      return JSON.parse(line);
    });
    this.queue = result.catch(() => {});
    return result;
  }

  // Ends the hold, committing or rolling back, and returns the add-in's summary. After a loss it reads the
  // outcome the add-in kept. Repeated calls return the same summary. A succeeded dry run adds what the add-in
  // reads before its rollback: { dryRun: { actions, export } }.
  end(outcome, extra = {}) {
    this.ending ||= (async () => {
      if (!this.lost) {
        try {
          const reply = await this.send({ type: "hold.end", end: { ...extra, outcome } });
          this.closing = true;
          this.pipe.destroy();
          if (reply.hold) return reply.hold;
        } catch (error) {
          if (error.code !== "HOLD_LOST") throw error;
        }
      }
      this.closing = true;
      this.pipe.destroy();
      return this.resultReader(this.processId, this.runId);
    })();
    return this.ending;
  }
}
