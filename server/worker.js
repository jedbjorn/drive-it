import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DEV, STANDARD } from "./mode.js";

const workerFile = fileURLToPath(new URL("./worker.py", import.meta.url));
// How long after the worker exits its output may still arrive before the run settles without it.
const OUTPUT_DRAIN_MS = 250;

export function defaultPythonPath() {
  if (process.env.DRIVE_IT_PYTHON) return process.env.DRIVE_IT_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

// Standard mode starts the worker without site and with only the environment it needs. Dev Mode
// (spec #10) runs site, so every installed package imports as Python would load it, and passes the
// user's environment, which pip and the processes a script starts expect (TEMP, APPDATA, proxies).
function workerLaunch(mode) {
  const python = { PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
  if (mode === DEV) return { args: ["-I", "-B", "-u", workerFile], env: { ...process.env, ...python } };
  return {
    args: ["-I", "-S", "-B", "-u", workerFile],
    env: { PATH: process.env.PATH || "", SYSTEMROOT: process.env.SYSTEMROOT || "", ...python },
  };
}

export function runWorker({ source, args, processId, document, runId, pythonPath, cwd, timeoutMs, onRequest, signal, mode = STANDARD, dryRun = false, requireDryRun = null }) {
  return new Promise((resolve, reject) => {
    const launch = workerLaunch(mode);
    const child = spawn(pythonPath || defaultPythonPath(), launch.args, {
      cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let final = null;
    let timeoutError = null;
    let exitCode;
    let openStreams = 2;
    let drain = null;
    // A run ended from outside (Stop, or the add-in ending its hold): the worker is stopped with that reason.
    const onAbort = () => {
      timeoutError = signal.reason;
      child.kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Script exceeded ${timeoutMs} ms and was stopped.`);
      timeoutError.code = "RUN_TIMEOUT";
      child.kill();
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      signal?.removeEventListener("abort", onAbort);
      lines.close();
      // A process the script left running may still hold stderr; it keeps draining but no longer holds Node open.
      child.stderr.unref?.();
      if (error) reject(error);
      else resolve(final);
    }

    lines.on("line", line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        finish(new Error(`Invalid worker response: ${line}`));
        child.kill();
        return;
      }
      if (message.type === "final") {
        final = message.receipt;
        return;
      }
      if (message.type !== "request") return;
      Promise.resolve(onRequest(message.method, message.params)).then(result => {
        child.stdin.write(`${JSON.stringify({ type: "response", id: message.id, result })}\n`);
      }, error => {
        child.stdin.write(`${JSON.stringify({ type: "response", id: message.id, error: { code: error.code || "WORKER_REQUEST_FAILED", message: error.message } })}\n`);
      });
    });
    // Decoded as a stream, so a character split across two chunks stays whole.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-16384);
    });
    child.on("error", finish);
    // The run settles when the worker exits, once its output has drained. In Dev Mode a process the script
    // started inherits the worker's stderr and can hold that pipe open after the worker is gone, so the drain
    // is bounded and a stop (the time limit, or an abort) settles at the exit itself.
    function settle() {
      if (settled) return;
      if (timeoutError) finish(timeoutError);
      else if (final && exitCode === 0) finish();
      else if (final) {
        final.status = "failed";
        final.error ||= { code: "WORKER_EXIT_FAILED", message: stderr || `Python worker exited with code ${exitCode}.` };
        finish();
      } else finish(new Error(stderr || `Python worker exited with code ${exitCode}.`));
    }
    const streamClosed = () => {
      if (--openStreams === 0 && exitCode !== undefined) settle();
    };
    child.stdout.on("close", streamClosed);
    child.stderr.on("close", streamClosed);
    child.on("exit", code => {
      exitCode = code;
      if (timeoutError || openStreams === 0) settle();
      else drain = setTimeout(settle, OUTPUT_DRAIN_MS);
    });
    child.stdin.on("error", error => {
      if (!settled && error.code !== "EPIPE") finish(error);
    });
    child.stdin.write(`${JSON.stringify({ type: "run", source, arguments: args, processId, document, runId, mode, dryRun, requireDryRun })}\n`);
  });
}
