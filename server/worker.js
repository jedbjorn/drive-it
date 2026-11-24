import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const workerFile = fileURLToPath(new URL("./worker.py", import.meta.url));

export function defaultPythonPath() {
  if (process.env.DRIVE_IT_PYTHON) return process.env.DRIVE_IT_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

export function runWorker({ source, args, processId, document, runId, pythonPath, cwd, timeoutMs, onRequest, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath || defaultPythonPath(), ["-I", "-S", "-B", "-u", workerFile], {
      cwd,
      env: {
        PATH: process.env.PATH || "",
        SYSTEMROOT: process.env.SYSTEMROOT || "",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let final = null;
    let timeoutError = null;
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
      signal?.removeEventListener("abort", onAbort);
      lines.close();
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
    child.on("close", code => {
      if (timeoutError) finish(timeoutError);
      else if (final && code === 0) finish();
      else if (final) {
        final.status = "failed";
        final.error ||= { code: "WORKER_EXIT_FAILED", message: stderr || `Python worker exited with code ${code}.` };
        finish();
      } else if (!settled) finish(new Error(stderr || `Python worker exited with code ${code}.`));
    });
    child.stdin.on("error", error => {
      if (!settled && error.code !== "EPIPE") finish(error);
    });
    child.stdin.write(`${JSON.stringify({ type: "run", source, arguments: args, processId, document, runId })}\n`);
  });
}
