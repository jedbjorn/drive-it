import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionStore } from "./decisions.js";
import { HistoryStore } from "./history.js";
import { executeBroker, readSession } from "./session.js";
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

export class Runtime {
  constructor({ dataDir = defaultDataDir(), pythonPath, brokerExecutor = executeBroker, sessionReader = readSession, workerRunner = runWorker, scriptResolver } = {}) {
    this.workspace = new WorkspaceStore(dataDir);
    this.decisions = new DecisionStore(dataDir);
    this.history = new HistoryStore(dataDir);
    this.policy = new WorkspacePolicy(this.workspace, this.decisions);
    this.pythonPath = pythonPath;
    this.brokerExecutor = brokerExecutor;
    this.sessionReader = sessionReader;
    this.workerRunner = workerRunner;
    this.scriptResolver = scriptResolver;
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

    let source = input.source;
    let savedScript = null;
    if (hasScript) {
      if (!this.scriptResolver) {
        const error = new Error("Saved script execution requires the script library integration.");
        error.code = "SCRIPT_LIBRARY_UNAVAILABLE";
        throw error;
      }
      const resolved = await this.scriptResolver(input.script);
      source = resolved.source;
      savedScript = { id: input.script.id, revision: input.script.revision, codeHash: hash(source) };
    }

    const idempotencyKey = input.idempotencyKey || randomUUID();
    const codeHash = hash(source);
    const fingerprint = JSON.stringify({
      codeHash,
      savedScript,
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

    const runId = previous?.runId || randomUUID();
    const startedAt = new Date().toISOString();
    const receipt = {
      runId,
      idempotencyKey,
      fingerprint,
      codeHash,
      savedScript,
      status: "failed",
      session: null,
      document: documentWithKind(input.document),
      workspaceRoot: null,
      arguments: input.arguments || {},
      changes: [],
      affectedFiles: [],
      affectedElements: [],
      checks: [],
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
      checks: receipt.checks,
    };
    let temporary;

    try {
      receipt.workspaceRoot = await this.workspace.getRoot();
      receipt.session = await this.sessionReader(input.processId);
      temporary = await mkdtemp(path.join(tmpdir(), "drive-it-"));
      const workerReceipt = await this.workerRunner({
        source,
        args: input.arguments || {},
        processId: input.processId,
        document: input.document || null,
        runId,
        pythonPath: this.pythonPath,
        cwd: temporary,
        timeoutMs: input.timeoutMs || 30000,
        onRequest: (method, params) => this.handleWorkerRequest(method, params, {
          ...context,
          runId,
          processId: input.processId,
          workspaceRoot: receipt.workspaceRoot,
          receipt,
          timeoutMs: input.timeoutMs || 30000,
        }),
      });
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

    receipt.policyDecisionIds = [...context.decisionIds];
    receipt.policyRequests = context.policyRequests;
    if (receipt.status !== "pending") receipt.completedAt = new Date().toISOString();
    await this.history.save(receipt);
    return receipt;
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
      const result = await this.policy.authorize(context.runId, [{ operation: params.operation, paths: params.paths }]);
      this.recordPolicy(context.receipt, context, result);
      return result;
    }
    if (method !== "broker.execute") throw new Error(`Unknown worker request: ${method}`);

    const operations = [];
    for (const operation of params.operations) {
      const args = { ...operation.arguments };
      for (const key of ["path", "templatePath"]) {
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
    let response = await this.brokerExecutor(context.processId, envelope, { timeoutMs: context.timeoutMs });
    if (response.status === "policy_required") {
      this.observeBroker(response, context);
      const decision = await this.policy.authorize(context.runId, response.policyRequests || []);
      this.recordPolicy(context.receipt, context, decision);
      if (decision.status === "approved") {
        const approvedEnvelope = {
          ...envelope,
          outsideRootApproval: { decisionId: decision.decisionId, grants: decision.grants },
        };
        response = await this.brokerExecutor(context.processId, approvedEnvelope, { timeoutMs: context.timeoutMs });
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
    return response;
  }

  observeBroker(response, context) {
    append(context.changes, response.changes);
    append(context.affectedFiles, response.affectedFiles);
    append(context.affectedElements, response.affectedElements);
    append(context.checks, response.checks);
    if (response.document) context.receipt.document = documentWithKind(response.document);
  }
}
