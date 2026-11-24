import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionStore } from "./decisions.js";
import { HistoryStore } from "./history.js";
import { DEV, installMode } from "./mode.js";
import { ScriptCatalog, validateArguments } from "./library.js";
import { revitContentFolders } from "./content.js";
import { executeBroker, openHold, readSession } from "./session.js";
import { SettingsStore } from "./settings.js";
import { defaultDataDir } from "./store.js";
import { runWorker } from "./worker.js";
import { canonicalPath, isOutsideRoot, WorkspacePolicy, WorkspaceStore } from "./workspace.js";
import { PIXEL_SIZE } from "./capture.js";

function hash(source) {
  return createHash("sha256").update(source).digest("hex");
}

// Spec #13 "The Call": a dry run exports at most this many views, named and created together.
export const DRY_RUN_VIEW_LIMIT = 4;
const VIEW_ID = /^[1-9][0-9]{0,18}$/;

function dryRunError(message) {
  const error = new Error(message);
  error.code = "INVALID_DRY_RUN";
  return error;
}

/** execute_script's dryRun as options: null for a real run (absent or false); true is a dry run with no images. */
export function dryRunOptions(value) {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return { views: [], createdViews: false, pixelSize: PIXEL_SIZE.default };
  if (typeof value !== "object" || Array.isArray(value)) throw dryRunError("dryRun takes true, false, or {views, createdViews, pixelSize}.");
  const views = (value.views ?? []).map(String);
  if (views.length > DRY_RUN_VIEW_LIMIT) throw dryRunError(`dryRun.views names ${views.length} views; a dry run exports at most ${DRY_RUN_VIEW_LIMIT}.`);
  const invalid = views.find(id => !VIEW_ID.test(id));
  if (invalid !== undefined) throw dryRunError(`dryRun.views holds ${JSON.stringify(invalid)}, which is not a Revit view id such as "312045".`);
  const pixelSize = value.pixelSize ?? PIXEL_SIZE.default;
  if (!Number.isInteger(pixelSize) || pixelSize < PIXEL_SIZE.min || pixelSize > PIXEL_SIZE.max) {
    throw dryRunError(`dryRun.pixelSize must be an integer from ${PIXEL_SIZE.min} through ${PIXEL_SIZE.max}.`);
  }
  return { views: [...new Set(views)], createdViews: value.createdViews === true, pixelSize };
}

/**
 * The call a run's fingerprint names, without its dry run options (spec #13 D12): a dry run and a real run of the
 * same code or saved revision, arguments, Revit process and target document are the same call. A real run's
 * fingerprint is its call.
 */
export function callOf(fingerprint) {
  const { dryRun, ...call } = JSON.parse(fingerprint);
  return JSON.stringify(call);
}

// Spec #13 "What Comes Back": fixed sentences for the model on every dry-run receipt.
export const DRY_RUN_NOTES = Object.freeze({
  rolledBack: "This was a dry run. Revit applied the script's changes, then every change was rolled back: nothing was kept and nothing was saved.",
  notRolledBack: "This was a dry run, but Revit could not roll back every change; the receipt's error names the documents that may have changed.",
  ids: "Element ids in this receipt (created elements, created views, transactions) no longer exist. Read ids again after the real run.",
  realRun: "Running it for real is a second execution: call execute_script again with the same source or saved revision and the same arguments, without dryRun.",
  skippedFileWrites: "File writes were skipped and are listed in skippedFileWrites; a file the script wrote earlier in the dry run was not there to read. The real run writes them, and asks about the paths outside the workspace root.",
  devFiles: "Dev Mode: only files.* writes were skipped. Plain Python file I/O (open, os, pathlib) is not intercepted in Dev Mode and ran for real.",
  released: document => `Drive-It released your borrowed elements in ${document} after the dry run (Relinquish, elements only), so the preview leaves nothing locked against colleagues. Revit cannot release single elements, so this includes unmodified elements you had borrowed before the dry run; elements you changed and have not synchronized stay yours.`,
  notReleased: document => `Drive-It could not release the elements this dry run borrowed in ${document}; colleagues cannot edit them until you use Relinquish All Mine or Synchronize with Central in Revit.`,
});

function documentWithKind(document) {
  if (!document) return null;
  const extension = document.path ? path.extname(document.path).toLowerCase() : "";
  return { ...document, kind: document.kind || (extension === ".rfa" ? "rfa" : extension === ".rvt" ? "rvt" : "unknown") };
}

function append(target, values) {
  if (Array.isArray(values)) target.push(...values);
}

// Receipt lists that hold Revit effects; inside a hold they are provisional until a save of their document,
// or the run's commit, keeps them.
const PROVISIONAL = ["changes", "affectedElements", "createdViews", "transactions"];

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
  constructor({ dataDir = defaultDataDir(), pythonPath, brokerExecutor = executeBroker, holdOpener = openHold, sessionReader = readSession, workerRunner = runWorker, scriptResolver, scripts, contentFolders = revitContentFolders, modeResolver = installMode, references = null } = {}) {
    this.workspace = new WorkspaceStore(dataDir);
    this.decisions = new DecisionStore(dataDir);
    this.history = new HistoryStore(dataDir);
    this.settings = new SettingsStore(dataDir);
    this.modeResolver = modeResolver;
    this.policy = new WorkspacePolicy(this.decisions, modeResolver);
    this.pythonPath = pythonPath;
    this.brokerExecutor = brokerExecutor;
    this.holdOpener = holdOpener;
    this.sessionReader = sessionReader;
    this.workerRunner = workerRunner;
    this.contentFolders = contentFolders;
    this.scripts = scripts || new ScriptCatalog({ workspace: this.workspace, history: this.history });
    this.scriptResolver = scriptResolver || ((reference, root) => this.scripts.resolve(reference, root));
    // Where a dry run's images are published (capture.js ReferenceImages); the MCP server sets it.
    this.references = references;
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
    const dryRun = dryRunOptions(input.dryRun);
    // Saved references fingerprint the request as made, so a completed run replays even
    // after its revision is retired or "latest" moves on. A dry run adds its options, so its key never
    // answers a real run, or the reverse; a real run's fingerprint is the call alone (callOf).
    const call = {
      codeHash: hasSource ? hash(input.source) : null,
      script: hasScript ? { scriptId: input.script.scriptId, revision: input.script.revision } : null,
      arguments: input.arguments || {},
      processId: input.processId,
      document: input.document || null,
    };
    const fingerprint = JSON.stringify(dryRun ? { ...call, dryRun } : call);
    const previous = await this.history.findIdempotent(idempotencyKey);
    if (previous && previous.fingerprint !== fingerprint) {
      const error = new Error("The idempotency key was already used for a different request.");
      error.code = "IDEMPOTENCY_CONFLICT";
      throw error;
    }
    if (previous && previous.status !== "pending") return previous;
    // The Script time limit bounds the run: every use of input.timeoutMs below sees the resolved value.
    input = { ...input, timeoutMs: await this.settings.runTimeoutMs(input.timeoutMs) };

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
      // From the install's resolver only; the request has no say (spec #10 "Mode Selection").
      mode: await this.modeResolver(),
      dryRun: Boolean(dryRun),
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
      dryRun,
      skippedFileWrites: [],
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
        mode: receipt.mode,
        dryRun: Boolean(dryRun),
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
      // A dry run never reads partially_applied: nothing it did is kept.
      if (["failed", "denied"].includes(receipt.status) && receipt.changes.length > 0 && !dryRun) {
        receipt.status = "partially_applied";
      }
      if (workerReceipt.policy) this.recordPolicy(receipt, context, workerReceipt.policy);
    } catch (error) {
      receipt.status = error.code === "RUN_TIMEOUT" ? "timed_out" : "failed";
      receipt.error = { code: error.code || "EXECUTION_FAILED", message: error.message };
    } finally {
      // In Dev Mode a process the script left running may still use the run's folder (on Windows its
      // working directory cannot be removed); the folder stays rather than costing the run its receipt.
      if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(error => {
        if (receipt.mode !== DEV) throw error;
      });
    }
    // A succeeded dry run that never reached Revit still exports the views it named, as the model stands.
    if (dryRun && receipt.status === "succeeded" && !context.holdPromise && (dryRun.views.length > 0 || dryRun.createdViews)) {
      await this.ensureHold(context).catch(() => {});
    }
    if (context.holdPromise) await this.endHold(receipt, context);
    if (dryRun) this.completeDryRun(receipt, context);
    else receipt.rehearsedBy = null;

    receipt.policyDecisionIds = [...context.decisionIds];
    receipt.policyRequests = context.policyRequests;
    if (receipt.status !== "pending") receipt.completedAt = new Date().toISOString();
    await this.history.save(receipt);
    return receipt;
  }

  readableRoots(context) {
    return this.contentFolders(context.receipt.session?.version);
  }

  recordPolicy(receipt, context, detail) {
    // A pending decision is reported twice, when it is made and again in the worker's receipt; record it once.
    const known = detail.decisionId && context.decisionIds.has(detail.decisionId);
    if (detail.decisionId) context.decisionIds.add(detail.decisionId);
    if (detail.policyRequests && !known) {
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
    if (method === "file.skip") return this.skipFileWrite(params, context);
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
    // A dry run holds Revit from its first request, built-in or bridge, so every change it makes is rolled back.
    if (context.dryRun && !context.hold) {
      try {
        await this.ensureHold(context);
      } catch (error) {
        return { status: "failed", error: { code: error.code || "HOLD_FAILED", message: `Revit could not be held for this dry run: ${error.message}` } };
      }
    }
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
    if (response.commitPoints !== undefined || response.effectDocuments !== undefined) {
      response = { ...response };
      delete response.commitPoints;
      delete response.effectDocuments;
    }
    return response;
  }

  // Spec #13 D4: a dry run's workspace file write is skipped and listed, with no outside-root decision.
  async skipFileWrite(params, context) {
    if (!context.dryRun) throw new Error("Only a dry run skips file writes.");
    for (const target of params.paths) {
      const canonical = await canonicalPath(target);
      context.skippedFileWrites.push({
        operation: params.operation,
        path: canonical,
        outsideRoot: isOutsideRoot(params.operation, canonical, context.workspaceRoot),
      });
    }
    return { skipped: true };
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
    const { documentKey, ...transaction } = response.value;
    const affectedElements = [...transaction.added, ...transaction.changed];
    this.observeBroker({
      changes: [transactionLine(transaction)],
      affectedElements,
      transactions: [transaction],
      effectDocuments: [{ document: documentKey, changes: 1, affectedElements: affectedElements.length, transactions: 1 }],
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
        dryRun: Boolean(context.dryRun),
      });
      context.hold = hold;
      context.heldAt = Date.now();
      context.uncommitted = [];
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
    const dry = context.dryRun;
    // A dry run always ends in a rollback. One that succeeded first has the add-in export its views and read its
    // actions with the groups still open (spec #13 "How It Works").
    const evidence = dry && receipt.status === "succeeded";
    const slots = evidence ? await this.stageDryRunImages(context) : [];
    try {
      summary = await hold.end(dry || receipt.status !== "succeeded" ? "rollback" : "commit", evidence ? {
        dryRun: {
          actions: true,
          export: slots.length ? { ...this.exportRequest(context.dryRun), targets: slots.map(slot => slot.target) } : null,
        },
      } : undefined);
    } catch {
      // Revit is gone; what it kept is unknown.
    }
    receipt.held = { ms: summary?.ms ?? Date.now() - context.heldAt, calls: summary?.calls ?? context.heldCalls };
    receipt.warnings = summary?.warnings ?? [];

    const failedDocuments = (summary?.documents || []).filter(document => document.state.endsWith("_failed"));
    if (dry) {
      await this.endDryRun(receipt, context, summary, failedDocuments, evidence ? slots : null);
      return;
    }
    if (summary?.outcome !== "committed") {
      for (const key of PROVISIONAL) {
        for (const entry of context.uncommitted.filter(item => item.key === key).sort((left, right) => right.position - left.position)) {
          context[key].splice(entry.position, 1);
        }
      }
      if (receipt.status === "succeeded" || !summary) this.holdEndedEarly(receipt, context, summary);
      // Effects the rollback removed no longer make the run partial; nothing else changes the status rule.
      if (receipt.status === "partially_applied" && receipt.changes.length === 0) {
        receipt.status = context.workerStatus === "denied" ? "denied" : "failed";
      }
    }
    if (failedDocuments.length) this.documentsFailed(receipt, failedDocuments);
  }

  // A run that succeeded, but whose hold the add-in ended on its own (Stop, deadline), or Revit is gone.
  holdEndedEarly(receipt, context, summary) {
    const code = summary?.outcome === "stopped_by_user" ? "stopped_by_user" : summary?.outcome === "timed_out" ? "RUN_TIMEOUT" : "HOLD_LOST";
    receipt.status = code === "RUN_TIMEOUT" ? "timed_out" : "failed";
    receipt.error = {
      code,
      message: code === "stopped_by_user" ? "Stopped from the Drive-It window; the run's changes were rolled back."
        : code === "RUN_TIMEOUT" ? `Script exceeded ${context.timeoutMs} ms and was stopped.`
          : "Revit's hold ended before the run did; what Revit kept is unknown.",
    };
  }

  documentsFailed(receipt, failedDocuments) {
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

  // The add-in's export request: the named views, then (with createdViews) views the script created, at most 4.
  exportRequest(dryRun) {
    return { views: dryRun.views, createdViews: dryRun.createdViews, pixelSize: dryRun.pixelSize };
  }

  // One empty staging directory per image the add-in may export: each named view, or the limit with createdViews.
  async stageDryRunImages(context) {
    const { views, createdViews } = context.dryRun;
    const count = createdViews ? DRY_RUN_VIEW_LIMIT : views.length;
    if (count === 0 || !this.references) return [];
    try {
      return await this.references.stageExports(count);
    } catch (error) {
      context.imageError = { code: error.code || "ARTIFACT_WRITE_FAILED", message: error.message };
      return [];
    }
  }

  // Spec #13: the receipt keeps what would have happened; the hold's outcome decides rolledBack and the status.
  // slots is null when the script did not succeed: then no view was exported.
  async endDryRun(receipt, context, summary, failedDocuments, slots) {
    context.rolledBack = Boolean(summary) && failedDocuments.length === 0
      && (summary.documents || []).every(document => document.state === "rolled_back");
    if (receipt.status === "succeeded" && summary?.outcome !== "rolled_back") this.holdEndedEarly(receipt, context, summary);
    if (failedDocuments.length) this.documentsFailed(receipt, failedDocuments);
    if (receipt.status === "succeeded") receipt.actions = summary?.actions ?? [];
    if (summary?.worksharing?.length) receipt.worksharing = summary.worksharing;
    receipt.images = slots ? await this.publishDryRunImages(receipt, context, summary?.images ?? [], slots) : [];
  }

  async publishDryRunImages(receipt, context, exported, slots) {
    const images = [];
    try {
      for (const image of exported) {
        const entry = { viewId: image.viewId ?? null, name: image.viewName ?? null, type: image.viewType ?? null, document: image.document?.title ?? null };
        const slot = slots.find(candidate => candidate.target === image.targetPath);
        if (image.error || !slot) {
          images.push({ ...entry, error: String(image.error?.code || "export_failed").toUpperCase(), message: image.error?.message || "Revit did not export the view." });
          continue;
        }
        try {
          const published = await this.references.publishExport(slot, {
            pixelSize: context.dryRun.pixelSize,
            purpose: `Dry run: ${receipt.displayName ?? receipt.runId}`,
            runId: receipt.runId,
            revit: { processId: context.processId, version: receipt.session?.version ?? null, build: receipt.session?.build ?? null },
            document: image.document,
            view: { id: image.viewId, uniqueId: image.viewUniqueId, name: image.viewName, type: image.viewType },
            fitDirection: image.fitDirection,
          });
          images.push({ ...entry, pixelSize: context.dryRun.pixelSize, width: published.metadata.image.width, height: published.metadata.image.height, path: published.absolutePath, sidecarPath: published.sidecarPath });
        } catch (error) {
          images.push({ ...entry, error: error.code || "ARTIFACT_WRITE_FAILED", message: error.message });
        }
      }
    } finally {
      if (slots.length) this.references.discardExports(slots);
    }
    // Named views the add-in did not report (Revit gone, or no staging) still get an entry each.
    for (const viewId of context.dryRun.views) {
      if (images.some(image => image.viewId === viewId)) continue;
      const reason = context.imageError ?? (this.references
        ? { code: "EXPORT_FAILED", message: "Revit did not export this view." }
        : { code: "IMAGES_UNAVAILABLE", message: "This server has no reference-image folder, so no view was exported." });
      images.push({ viewId, name: null, type: null, document: null, ...reason });
    }
    return images;
  }

  // The dry-run fields every dry-run receipt carries, held or not (spec #13 "What Comes Back").
  completeDryRun(receipt, context) {
    // A dry run that never reached Revit changed nothing there.
    receipt.rolledBack = context.rolledBack ?? true;
    receipt.warnings ??= [];
    receipt.images ??= [];
    receipt.skippedFileWrites = context.skippedFileWrites;
    if (receipt.status === "succeeded") receipt.actions ??= [];
    const notes = [receipt.rolledBack ? DRY_RUN_NOTES.rolledBack : DRY_RUN_NOTES.notRolledBack, DRY_RUN_NOTES.ids, DRY_RUN_NOTES.realRun];
    if (receipt.skippedFileWrites.length) notes.push(DRY_RUN_NOTES.skippedFileWrites);
    if (receipt.mode === DEV) notes.push(DRY_RUN_NOTES.devFiles);
    for (const entry of receipt.worksharing ?? []) {
      notes.push(entry.released ? DRY_RUN_NOTES.released(entry.document) : DRY_RUN_NOTES.notReleased(entry.document));
    }
    receipt.notes = notes;
  }

  observeBroker(response, context) {
    // In a hold, Revit effects stay provisional until a save keeps them; a rollback removes them again.
    // A save (or close) keeps what the run did to that document only: its earlier effects, and this
    // response's effects in that document up to the save. Other documents' effects stay provisional.
    if (context.uncommitted) {
      const points = response.commitPoints || [];
      const marks = response.effectDocuments || [];
      const documentOf = (key, index) => marks.find(mark => (mark[key] ?? 0) > index)?.document ?? null;
      context.uncommitted = context.uncommitted.filter(entry => !points.some(point => point.document === entry.document));
      for (const key of PROVISIONAL) {
        const values = Array.isArray(response[key]) ? response[key] : [];
        for (let index = 0; index < values.length; index += 1) {
          const document = documentOf(key, index);
          if (document !== null && points.some(point => point.document === document && index < (point[key] ?? 0))) continue;
          context.uncommitted.push({ key, position: context[key].length + index, document });
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
