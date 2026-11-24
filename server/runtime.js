import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionStore } from "./decisions.js";
import { HistoryStore } from "./history.js";
import { ScriptCatalog, validateArguments } from "./library.js";
import { revitContentFolders } from "./content.js";
import { executeBroker, openHold, readSession } from "./session.js";
import { defaultDataDir } from "./store.js";
import { runWorker } from "./worker.js";
import { canonicalPath, WorkspacePolicy, WorkspaceStore } from "./workspace.js";

function hash(source) {
  return createHash("sha256").update(source).digest("hex");
}

function documentWithKind(document) {
  if (!document) return null;
  const extension = document.path ? path.extname(document.path).toLowerCase() : "";
  return { ...document, kind: document.kind || (extension === ".rfa" ? "rfa" : extension === ".rvt" ? "rvt" : "unknown") };
}

function append(target, values) {
  if (Array.isArray(values)) target.push(...values);
}

// Receipt lists that hold Revit effects; inside a hold they are provisional until a save or a commit.
const PROVISIONAL = ["changes", "affectedElements", "createdViews", "transactions"];

function provisional() {
  return { changes: [], affectedElements: [], createdViews: [], transactions: [] };
}

// Bridge members that only read the file a path names, so Revit's installed content passes (decision #23).
// A path given to any other member is checked as a write.
const BRIDGE_READS = new Set(["LoadFamily", "LoadFamilySymbol"]);

// A string argument that is an absolute file path goes through the outside-root policy (spec #15 "Guardrails").
function isAbsoluteFilePath(value) {
  return typeof value === "string" && !/[\r\n]/.test(value)
    && path.isAbsolute(value) && /[^\\/]/.test(value);
}

function bridgePaths(value, found = []) {
  if (isAbsoluteFilePath(value)) found.push(value);
  else if (Array.isArray(value)) for (const item of value) bridgePaths(item, found);
  return found;
}

// Replaces each checked path with its canonical form, so Revit gets the path the policy decided on.
function withCanonicalPaths(value, canonical) {
  if (isAbsoluteFilePath(value)) return canonical.get(value);
  return Array.isArray(value) ? value.map(item => withCanonicalPaths(item, canonical)) : value;
}

function transactionLine(transaction) {
  const { added, changed, deleted } = transaction.totals;
  return `${transaction.name} in ${transaction.document}: ${added} added, ${changed} changed, ${deleted} deleted.`;
}

export class Runtime {
  constructor({ dataDir = defaultDataDir(), pythonPath, brokerExecutor = executeBroker, holdOpener = openHold, sessionReader = readSession, workerRunner = runWorker, scriptResolver, scripts, contentFolders = revitContentFolders } = {}) {
    this.workspace = new WorkspaceStore(dataDir);
    this.decisions = new DecisionStore(dataDir);
    this.history = new HistoryStore(dataDir);
    this.policy = new WorkspacePolicy(this.decisions);
    this.pythonPath = pythonPath;
    this.brokerExecutor = brokerExecutor;
    this.holdOpener = holdOpener;
    this.sessionReader = sessionReader;
    this.workerRunner = workerRunner;
    this.contentFolders = contentFolders;
    this.scripts = scripts || new ScriptCatalog({ workspace: this.workspace, history: this.history });
    this.scriptResolver = scriptResolver || ((reference, root) => this.scripts.resolve(reference, root));
    this.inFlight = new Map();
  }

  async execute(input) {
    const request = { ...input, idempotencyKey: input.idempotencyKey || randomUUID() };
    if (this.inFlight.has(request.idempotencyKey)) return this.inFlight.get(request.idempotencyKey);
    const promise = this.executeInternal(request).finally(() => this.inFlight.delete(request.idempotencyKey));
    this.inFlight.set(request.idempotencyKey, promise);
    return promise;
  }

  async executeInternal(input) {
    const hasSource = typeof input.source === "string";
    const hasScript = input.script !== undefined;
    if (hasSource === hasScript) {
      const error = new Error("Provide exactly one of inline source or a saved script reference.");
      error.code = "AMBIGUOUS_SCRIPT";
      throw error;
    }

    const idempotencyKey = input.idempotencyKey || randomUUID();
    // Saved references fingerprint the request as made, so a completed run replays even
    // after its revision is retired or "latest" moves on.
    const fingerprint = JSON.stringify({
      codeHash: hasSource ? hash(input.source) : null,
      script: hasScript ? { scriptId: input.script.scriptId, revision: input.script.revision } : null,
      arguments: input.arguments || {},
      processId: input.processId,
      document: input.document || null,
    });
    const previous = await this.history.findIdempotent(idempotencyKey);
    if (previous && previous.fingerprint !== fingerprint) {
      const error = new Error("The idempotency key was already used for a different request.");
      error.code = "IDEMPOTENCY_CONFLICT";
      throw error;
    }
    if (previous && previous.status !== "pending") return previous;

    let source = input.source;
    let savedScript = null;
    let args = input.arguments || {};
    let workspaceRoot = null;
    if (hasScript) {
      // Resolve against the same root snapshot the run will use for every authorization.
      workspaceRoot = await this.workspace.getRoot();
      const resolved = await this.scriptResolver(input.script, workspaceRoot);
      source = resolved.source;
      if (resolved.inputSchema) args = validateArguments(resolved, args);
      savedScript = {
        scriptId: resolved.scriptId,
        revision: resolved.revision,
        codeHash: hash(source),
        state: resolved.state,
        requested: input.script.revision,
      };
    }
    const codeHash = hash(source);

    const runId = previous?.runId || randomUUID();
    const startedAt = new Date().toISOString();
    const receipt = {
      runId,
      displayName: input.displayName ?? null,
      idempotencyKey,
      fingerprint,
      codeHash,
      savedScript,
      status: "failed",
      session: null,
      document: documentWithKind(input.document),
      workspaceRoot: null,
      arguments: args,
      changes: [],
      affectedFiles: [],
      affectedElements: [],
      createdViews: [],
      checks: [],
      held: null,
      policyDecisionIds: [],
      policyRequests: [],
      result: null,
      logs: "",
      error: null,
      startedAt,
      completedAt: null,
    };
    const context = {
      decisionIds: new Set(),
      policyRequests: [],
      changes: receipt.changes,
      affectedFiles: receipt.affectedFiles,
      affectedElements: receipt.affectedElements,
      createdViews: receipt.createdViews,
      checks: receipt.checks,
      runId,
      processId: input.processId,
      receipt,
      timeoutMs: input.timeoutMs || 30000,
      deadline: Date.now() + (input.timeoutMs || 30000),
      stop: new AbortController(),
      holdPromise: null,
      hold: null,
      heldAt: null,
      heldCalls: 0,
      uncommitted: null,
      workerStatus: null,
    };
    let temporary;

    try {
      receipt.workspaceRoot = workspaceRoot || await this.workspace.getRoot();
      // While another run holds Revit the pipe is busy; this run waits for it, within its own time.
      receipt.session = await this.sessionReader(input.processId, { connectWaitMs: Math.max(0, context.deadline - Date.now()) });
      temporary = await mkdtemp(path.join(tmpdir(), "drive-it-"));
      const workerReceipt = await this.workerRunner({
        source,
        args,
        processId: input.processId,
        document: input.document || null,
        runId,
        pythonPath: this.pythonPath,
        cwd: temporary,
        timeoutMs: input.timeoutMs || 30000,
        signal: context.stop.signal,
        onRequest: (method, params) => this.handleWorkerRequest(method, params, Object.assign(context, {
          workspaceRoot: receipt.workspaceRoot,
        })),
      });
      context.workerStatus = workerReceipt.status;
      Object.assign(receipt, {
        status: workerReceipt.status,
        result: workerReceipt.result ?? null,
        logs: workerReceipt.logs || "",
        error: workerReceipt.error || null,
      });
      if (["failed", "denied"].includes(receipt.status) && receipt.changes.length > 0) {
        receipt.status = "partially_applied";
      }
      if (workerReceipt.policy) this.recordPolicy(receipt, context, workerReceipt.policy);
    } catch (error) {
      receipt.status = error.code === "RUN_TIMEOUT" ? "timed_out" : "failed";
      receipt.error = { code: error.code || "EXECUTION_FAILED", message: error.message };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    if (context.holdPromise) await this.endHold(receipt, context);

    receipt.policyDecisionIds = [...context.decisionIds];
    receipt.policyRequests = context.policyRequests;
    if (receipt.status !== "pending") receipt.completedAt = new Date().toISOString();
    await this.history.save(receipt);
    return receipt;
  }

  readableRoots(context) {
    return this.contentFolders(context.receipt.session?.version || "2026");
  }

  recordPolicy(receipt, context, detail) {
    if (detail.decisionId) context.decisionIds.add(detail.decisionId);
    if (detail.policyRequests) {
      context.policyRequests.push(...detail.policyRequests);
      receipt.policyRequests = context.policyRequests;
    }
    receipt.policyDecisionIds = [...context.decisionIds];
  }

  async handleWorkerRequest(method, params, context) {
    if (method === "effect.record") {
      const effect = { operation: params.operation, paths: params.paths };
      context.affectedFiles.push(effect);
      if (!params.operation.startsWith("read_")) context.changes.push(effect);
      return { recorded: true };
    }
    if (method === "check.record") {
      context.checks.push({ name: params.name, passed: params.passed, observed: params.observed });
      return { recorded: true };
    }
    if (method === "workspace.authorize") {
      const result = await this.policy.authorize(context.runId, [{ operation: params.operation, paths: params.paths }], context.workspaceRoot, context.receipt.displayName, this.readableRoots(context));
      this.recordPolicy(context.receipt, context, result);
      return result;
    }
    if (method === "bridge.call") return this.bridgeCall(params, context);
    if (method !== "broker.execute") throw new Error(`Unknown worker request: ${method}`);

    const operations = [];
    for (const operation of params.operations) {
      const args = { ...operation.arguments };
      for (const key of ["path", "destinationPath", "templatePath"]) {
        if (typeof args[key] === "string") args[key] = await canonicalPath(args[key]);
      }
      operations.push({ type: operation.type, arguments: args });
    }
    const documentPath = params.document?.path ? await canonicalPath(params.document.path) : null;
    const envelope = {
      id: context.runId,
      type: "model.execute",
      document: { path: documentPath, uniqueId: params.document?.uniqueId || null },
      workspaceRoot: context.workspaceRoot,
      operations,
    };
    // Once a run holds Revit, its built-in operations go through the hold and join its transaction groups.
    const execute = message => context.hold
      ? context.hold.send(message)
      : this.brokerExecutor(context.processId, message, {
        timeoutMs: context.timeoutMs,
        connectWaitMs: Math.max(0, context.deadline - Date.now()),
      });
    let response = await execute(envelope);
    if (response.status === "policy_required") {
      this.observeBroker(response, context);
      const decision = await this.policy.authorize(context.runId, response.policyRequests || [], context.workspaceRoot, context.receipt.displayName, this.readableRoots(context));
      this.recordPolicy(context.receipt, context, decision);
      if (decision.status === "approved" || decision.grants?.length) {
        const approvedEnvelope = {
          ...envelope,
          outsideRootApproval: { decisionId: decision.decisionId || "revit-content", grants: decision.grants },
        };
        response = await execute(approvedEnvelope);
      } else {
        response = {
          ...response,
          status: decision.status,
          decisionId: decision.decisionId,
          policyRequests: decision.policyRequests,
        };
      }
    }
    this.observeBroker(response, context);
    if (response.commitPoint !== undefined) {
      response = { ...response };
      delete response.commitPoint;
    }
    return response;
  }

  async bridgeCall(params, context) {
    if (params.op === "describe") return this.describe(params, context);
    const call = { ...params };
    if (call.document && typeof call.document === "object" && !("$h" in call.document)) {
      call.document = {
        path: call.document.path ? await canonicalPath(call.document.path) : null,
        uniqueId: call.document.uniqueId || null,
      };
    }
    // Checked before Revit is held: no decision is awaited while Revit is paused.
    const paths = [...bridgePaths(call.args), ...bridgePaths(call.value)];
    if (paths.length) {
      const operation = BRIDGE_READS.has(call.member) ? "read_file" : "write_file";
      const decision = await this.policy.authorize(context.runId, [{ operation, paths }], context.workspaceRoot, context.receipt.displayName, this.readableRoots(context));
      this.recordPolicy(context.receipt, context, decision);
      if (decision.status === "pending" || decision.status === "denied") return decision;
      const canonical = new Map(paths.map((original, index) => [original, decision.requests[0].paths[index]]));
      if (call.args) call.args = withCanonicalPaths(call.args, canonical);
      if ("value" in call) call.value = withCanonicalPaths(call.value, canonical);
    }
    let hold;
    try {
      hold = await this.ensureHold(context);
    } catch (error) {
      return { status: "failed", error: { code: error.code || "HOLD_FAILED", message: `Revit could not be held for this run: ${error.message}` } };
    }
    context.heldCalls += 1;
    const response = await hold.send({ type: "bridge.call", call });
    if (call.op !== "tx.commit" || response.status !== "succeeded" || !response.value) return response;
    // A committed revit.transaction: one changes line, its added and changed ids, and the transaction itself.
    const transaction = response.value;
    this.observeBroker({
      changes: [transactionLine(transaction)],
      affectedElements: [...transaction.added, ...transaction.changed],
      transactions: [transaction],
    }, context);
    return { ...response, value: null };
  }

  // revit.describe reads the running Revit's API without holding it: through the run's hold if it has one,
  // otherwise as its own request, which the add-in answers without Revit's thread.
  async describe(params, context) {
    const call = { op: "describe", type: params.type };
    if (context.hold) return context.hold.send({ type: "bridge.call", call });
    return this.brokerExecutor(context.processId, { id: context.runId, type: "api.describe", describe: { type: params.type } }, {
      timeoutMs: context.timeoutMs,
      connectWaitMs: Math.max(0, context.deadline - Date.now()),
    });
  }

  // The hold starts at the run's first bridge call and is bounded by the time the run has left.
  ensureHold(context) {
    context.holdPromise ||= (async () => {
      const timeLimitMs = Math.max(1, Math.floor(context.deadline - Date.now()));
      const hold = await this.holdOpener(context.processId, {
        runId: context.runId,
        displayName: context.receipt.displayName,
        timeLimitMs,
      });
      context.hold = hold;
      context.heldAt = Date.now();
      context.uncommitted = provisional();
      context.transactions = context.receipt.transactions = [];
      hold.onLost(() => this.holdLost(context));
      return hold;
    })();
    return context.holdPromise;
  }

  // The add-in ended the hold on its own (deadline, Stop, Revit closing): the run is over.
  async holdLost(context) {
    let summary = null;
    try {
      summary = await context.hold.end("rollback");
    } catch {
      // Revit is gone; the run still ends.
    }
    const error = summary?.outcome === "stopped_by_user"
      ? new Error("Stopped from the Drive-It window. Every change this run made after its last save was rolled back.")
      : summary?.outcome === "timed_out"
        ? new Error(`Script exceeded ${context.timeoutMs} ms and was stopped.`)
        : new Error("Revit ended the hold before the run finished; its changes after the last save were rolled back.");
    error.code = summary?.outcome === "stopped_by_user" ? "stopped_by_user" : summary?.outcome === "timed_out" ? "RUN_TIMEOUT" : "HOLD_LOST";
    context.stop.abort(error);
  }

  // Commits a held run that succeeded, otherwise restores it, and reports the hold on the receipt.
  async endHold(receipt, context) {
    let hold;
    try {
      hold = await context.holdPromise;
    } catch {
      return;
    }
    let summary = null;
    try {
      summary = await hold.end(receipt.status === "succeeded" ? "commit" : "rollback");
    } catch {
      // Revit is gone; what it kept is unknown.
    }
    receipt.held = { ms: summary?.ms ?? Date.now() - context.heldAt, calls: summary?.calls ?? context.heldCalls };
    receipt.warnings = summary?.warnings ?? [];

    const failedDocuments = (summary?.documents || []).filter(document => document.state.endsWith("_failed"));
    if (summary?.outcome !== "committed") {
      for (const key of PROVISIONAL) {
        for (const index of [...context.uncommitted[key]].sort((left, right) => right - left)) context[key].splice(index, 1);
      }
      if (receipt.status === "succeeded" || !summary) {
        const code = summary?.outcome === "stopped_by_user" ? "stopped_by_user" : summary?.outcome === "timed_out" ? "RUN_TIMEOUT" : "HOLD_LOST";
        receipt.status = code === "RUN_TIMEOUT" ? "timed_out" : "failed";
        receipt.error = {
          code,
          message: code === "stopped_by_user" ? "Stopped from the Drive-It window; the run's changes were rolled back."
            : code === "RUN_TIMEOUT" ? `Script exceeded ${context.timeoutMs} ms and was stopped.`
              : "Revit's hold ended before the run did; what Revit kept is unknown.",
        };
      }
      // Effects the rollback removed no longer make the run partial; nothing else changes the status rule.
      if (receipt.status === "partially_applied" && receipt.changes.length === 0) {
        receipt.status = context.workerStatus === "denied" ? "denied" : "failed";
      }
    }
    if (failedDocuments.length) {
      const rollback = failedDocuments.some(document => document.state === "rollback_failed");
      receipt.status = receipt.status === "succeeded" ? "failed" : receipt.status;
      receipt.error = {
        code: rollback ? "rollback_failed" : "commit_failed",
        message: rollback
          ? `Revit could not roll back this run's changes to ${failedDocuments.map(document => document.title).join(", ")}; those models may have changed.`
          : `Revit could not keep this run's changes to ${failedDocuments.map(document => document.title).join(", ")}.`,
        documents: failedDocuments,
        cause: receipt.error,
      };
    }
  }

  observeBroker(response, context) {
    // In a hold, Revit effects stay provisional until a save keeps them; a rollback removes them again.
    // A save keeps everything before it, and this response's effects up to its position in the batch.
    const kept = response.commitPoint;
    if (kept) context.uncommitted = provisional();
    if (context.uncommitted) {
      for (const key of PROVISIONAL) {
        const values = Array.isArray(response[key]) ? response[key] : [];
        for (let index = kept?.[key] ?? 0; index < values.length; index += 1) {
          context.uncommitted[key].push(context[key].length + index);
        }
      }
    }
    append(context.changes, response.changes);
    append(context.affectedFiles, response.affectedFiles);
    append(context.affectedElements, response.affectedElements);
    append(context.createdViews, response.createdViews);
    if (context.transactions) append(context.transactions, response.transactions);
    append(context.checks, response.checks);
    if (response.document) context.receipt.document = documentWithKind(response.document);
  }
}
