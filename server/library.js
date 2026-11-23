import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "./store.js";

export const SCRIPT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOCUMENT_KINDS = ["rvt", "rfa"];

export function libraryError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

export function codeHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function samePath(a, b) {
  return typeof a === "string" && typeof b === "string" && path.relative(a, b) === "";
}

function slug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "script";
}

export function compileInputSchema(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) || inputSchema.type !== "object") {
    throw libraryError("INVALID_INPUT_SCHEMA", "inputSchema must be a JSON Schema object with type \"object\".");
  }
  try {
    return z.fromJSONSchema(inputSchema);
  } catch (error) {
    throw libraryError("INVALID_INPUT_SCHEMA", `inputSchema is not supported: ${error.message}`);
  }
}

export function validateArguments(revision, args) {
  const result = compileInputSchema(revision.inputSchema).safeParse(args ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map(issue => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`);
  throw libraryError("INVALID_ARGUMENTS", `Arguments do not match ${revision.scriptId} revision ${revision.revision}: ${issues.join("; ")}`, issues);
}

export function summarize(revision) {
  return {
    scriptId: revision.scriptId,
    revision: revision.revision,
    name: revision.name,
    purpose: revision.purpose,
    domain: revision.domain,
    documentKind: revision.documentKind,
    state: revision.state,
    codeHash: revision.codeHash,
    createdAt: revision.createdAt,
    promotedAt: revision.promotedAt,
    retiredAt: revision.retiredAt,
  };
}

// A run counts as promotion evidence only with at least one check and every check passed.
export function checkedSuccess(receipt) {
  return receipt.status === "succeeded" && Array.isArray(receipt.checks)
    && receipt.checks.length > 0 && receipt.checks.every(check => check.passed === true);
}

// One workspace root's script library. Revision files are immutable; lifecycle lives in
// sibling state files. Absent state means draft (the state at creation).
export class ScriptLibrary {
  constructor(root) {
    this.root = root;
    this.directory = path.join(root, ".drive-it", "scripts");
  }

  scriptDirectory(scriptId) {
    if (!SCRIPT_ID.test(scriptId)) throw libraryError("INVALID_SCRIPT_ID", `Invalid scriptId: ${scriptId}`);
    return path.join(this.directory, scriptId);
  }

  async ensureReadable() {
    let info;
    try {
      info = await stat(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw libraryError("LIBRARY_NOT_FOUND", `No script library exists in workspace ${this.root} yet; save_script creates it at ${this.directory}.`);
      }
      throw libraryError("LIBRARY_UNREADABLE", `The script library at ${this.directory} cannot be read: ${error.message}`);
    }
    if (!info.isDirectory()) throw libraryError("LIBRARY_UNREADABLE", `The script library path ${this.directory} is not a directory.`);
  }

  async revisionNumbers(scriptId) {
    let names;
    try {
      names = await readdir(this.scriptDirectory(scriptId));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw libraryError("LIBRARY_UNREADABLE", `Script ${scriptId} cannot be read: ${error.message}`);
    }
    return names.map(name => /^(\d+)\.json$/.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
  }

  async readRevision(scriptId, revision) {
    const directory = this.scriptDirectory(scriptId);
    const file = path.join(directory, `${revision}.json`);
    let row;
    let state;
    try {
      row = JSON.parse(await readFile(file, "utf8"));
      state = await readJson(path.join(directory, `${revision}.state.json`));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw libraryError("LIBRARY_UNREADABLE", `Script revision ${file} cannot be read: ${error.message}`);
    }
    if (row.scriptId !== scriptId || row.revision !== revision || codeHash(row.source) !== row.codeHash) {
      throw libraryError("LIBRARY_UNREADABLE", `Script revision ${file} failed its identity or code hash check.`);
    }
    return {
      ...row,
      state: state?.state || "draft",
      promotedAt: state?.promotedAt || null,
      promotionRunId: state?.promotionRunId || null,
      promotionEvidence: state?.promotionEvidence || null,
      retiredAt: state?.retiredAt || null,
      retirementReason: state?.retirementReason || null,
    };
  }

  async get(scriptId, revision) {
    await this.ensureReadable();
    if (revision === "latest") return this.latestActive(scriptId);
    const row = await this.readRevision(scriptId, revision);
    if (!row) throw libraryError("SCRIPT_NOT_FOUND", `Script ${scriptId} revision ${revision} does not exist in workspace ${this.root}.`);
    return row;
  }

  async latestActive(scriptId) {
    const numbers = await this.revisionNumbers(scriptId);
    if (numbers.length === 0) throw libraryError("SCRIPT_NOT_FOUND", `Script ${scriptId} does not exist in workspace ${this.root}.`);
    for (const number of numbers.reverse()) {
      const row = await this.readRevision(scriptId, number);
      if (row?.state === "active") return row;
    }
    throw libraryError("NO_ACTIVE_REVISION", `Script ${scriptId} has no active revision; reference an exact draft revision instead.`);
  }

  async list() {
    await this.ensureReadable();
    let names;
    try {
      names = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      throw libraryError("LIBRARY_UNREADABLE", `The script library at ${this.directory} cannot be read: ${error.message}`);
    }
    const rows = [];
    for (const entry of names) {
      if (!entry.isDirectory() || !SCRIPT_ID.test(entry.name)) continue;
      for (const number of await this.revisionNumbers(entry.name)) {
        const row = await this.readRevision(entry.name, number);
        if (row) rows.push(row);
      }
    }
    return rows;
  }

  async findIdempotent(idempotencyKey) {
    try {
      await this.ensureReadable();
    } catch (error) {
      if (error.code === "LIBRARY_NOT_FOUND") return null;
      throw error;
    }
    return (await this.list()).find(row => row.idempotencyKey === idempotencyKey) || null;
  }

  async createScriptId(name) {
    await mkdir(this.directory, { recursive: true });
    const base = slug(name);
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;
      try {
        await mkdir(path.join(this.directory, candidate));
        return candidate;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    throw libraryError("LIBRARY_WRITE_FAILED", `Could not allocate a scriptId for ${name}.`);
  }

  // Publishes the next integer revision. link() fails if the target exists, so concurrent
  // writers receive distinct revisions and the final name only ever holds complete content.
  async publish(scriptId, body) {
    const directory = this.scriptDirectory(scriptId);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    let revision = ((await this.revisionNumbers(scriptId)).at(-1) || 0) + 1;
    try {
      for (;;) {
        const row = { ...body, scriptId, revision };
        await writeFile(temporary, `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
        try {
          await link(temporary, path.join(directory, `${revision}.json`));
          return row;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          revision += 1;
        }
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async writeState(revision, state) {
    await writeJsonAtomic(path.join(this.scriptDirectory(revision.scriptId), `${revision.revision}.state.json`), state);
  }
}

// MCP-facing lifecycle over the current workspace root's library and the run history.
export class ScriptCatalog {
  constructor({ workspace, history }) {
    this.workspace = workspace;
    this.history = history;
    this.queue = Promise.resolve();
  }

  // Serializes lifecycle writes in this process so read-check-write transitions stay atomic.
  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async library(root) {
    return new ScriptLibrary(root || await this.workspace.getRoot());
  }

  async save(input) {
    const hasName = typeof input.name === "string" && input.name.trim() !== "";
    if (!input.scriptId && (!hasName || input.inputSchema === undefined)) {
      throw libraryError("INVALID_SCRIPT", "A new script requires a name, documentKind, and inputSchema.");
    }
    if (input.inputSchema !== undefined) compileInputSchema(input.inputSchema);
    const root = await this.workspace.getRoot();
    const library = await this.library(root);
    const hash = codeHash(input.source);
    const sourceRunIds = [...new Set(input.sourceRunIds || [])];
    for (const runId of sourceRunIds) {
      const receipt = await this.history.get(runId);
      if (!receipt) throw libraryError("RUN_NOT_FOUND", `Source run ${runId} does not exist.`);
      if (receipt.codeHash !== hash) throw libraryError("SOURCE_RUN_MISMATCH", `Source run ${runId} executed code ${receipt.codeHash}, not the saved source ${hash}.`);
    }

    return this.exclusive(async () => {
      if (input.idempotencyKey) {
        const existing = await library.findIdempotent(input.idempotencyKey);
        if (existing) {
          if (existing.codeHash !== hash || (input.scriptId && existing.scriptId !== input.scriptId)) {
            throw libraryError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used to save a different script revision.");
          }
          return { created: false, revision: existing };
        }
      }
      let previous = null;
      let scriptId = input.scriptId;
      if (scriptId) {
        const numbers = await library.revisionNumbers(scriptId);
        if (numbers.length === 0) throw libraryError("SCRIPT_NOT_FOUND", `Script ${scriptId} does not exist in workspace ${root}; omit scriptId to create a new script.`);
        previous = await library.readRevision(scriptId, numbers.at(-1));
      } else {
        scriptId = await library.createScriptId(input.name);
      }
      const field = (key, fallback) => input[key] !== undefined ? input[key] : previous ? previous[key] : fallback;
      const documentKind = field("documentKind");
      if (!DOCUMENT_KINDS.includes(documentKind)) throw libraryError("INVALID_SCRIPT", "documentKind must be rvt or rfa.");
      const row = await library.publish(scriptId, {
        name: field("name"),
        purpose: field("purpose", ""),
        domain: field("domain", ""),
        documentKind,
        inputSchema: field("inputSchema"),
        outputs: field("outputs", ""),
        expectedEffects: field("expectedEffects", []),
        capabilities: field("capabilities", []),
        assumptions: field("assumptions", ""),
        source: input.source,
        codeHash: hash,
        idempotencyKey: input.idempotencyKey || null,
        sourceRunIds,
        workspaceRoot: root,
        createdAt: new Date().toISOString(),
      });
      return { created: true, revision: await library.readRevision(scriptId, row.revision) };
    });
  }

  async search({ query, domain, documentKind, includeDrafts = false, includeRetired = false } = {}) {
    const library = await this.library();
    const states = new Set(["active", ...(includeDrafts ? ["draft"] : []), ...(includeRetired ? ["retired"] : [])]);
    const terms = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (await library.list()).filter(row => states.has(row.state)
      && (!documentKind || row.documentKind === documentKind)
      && (!domain || row.domain.toLowerCase() === domain.toLowerCase())
      && terms.every(term => [row.scriptId, row.name, row.purpose, row.domain, row.documentKind]
        .some(value => value.toLowerCase().includes(term))));
    rows.sort((a, b) => a.scriptId.localeCompare(b.scriptId) || b.revision - a.revision);
    return { workspaceRoot: library.root, scripts: rows.map(summarize) };
  }

  async runsFor(row) {
    return (await this.history.list())
      .filter(receipt => receipt.savedScript?.scriptId === row.scriptId && receipt.savedScript?.revision === row.revision
        && receipt.codeHash === row.codeHash && samePath(receipt.workspaceRoot, row.workspaceRoot))
      .map(receipt => ({
        runId: receipt.runId,
        status: receipt.status,
        checked: checkedSuccess(receipt),
        checks: receipt.checks,
        arguments: receipt.arguments,
        document: receipt.document,
        revitVersion: receipt.session?.version ?? null,
        affectedFiles: receipt.affectedFiles,
        affectedElements: receipt.affectedElements,
        createdViews: receipt.createdViews ?? [],
        error: receipt.error,
        startedAt: receipt.startedAt,
        completedAt: receipt.completedAt,
      }));
  }

  async get({ scriptId, revision }) {
    const library = await this.library();
    const row = await library.get(scriptId, revision);
    const { idempotencyKey, ...detail } = row;
    return { ...detail, runs: await this.runsFor(row) };
  }

  // Resolves an execution reference against the run's root snapshot.
  async resolve({ scriptId, revision }, root) {
    const library = await this.library(root);
    const row = await library.get(scriptId, revision);
    if (row.state === "retired") throw libraryError("SCRIPT_RETIRED", `Script ${scriptId} revision ${row.revision} is retired and cannot be executed.`);
    return row;
  }

  async promote({ scriptId, revision, runId }) {
    const root = await this.workspace.getRoot();
    const library = await this.library(root);
    return this.exclusive(async () => {
      const row = await library.get(scriptId, revision);
      const receipt = await this.history.get(runId);
      const unmet = [];
      const require = (condition, ok, expected, observed) => {
        if (!ok) unmet.push({ condition, expected, observed });
      };
      require("draft", row.state === "draft", "draft", row.state);
      if (!receipt) {
        unmet.push({ condition: "run_exists", expected: runId, observed: null });
      } else {
        require("same_workspace", samePath(receipt.workspaceRoot, root), root, receipt.workspaceRoot);
        require("same_script", receipt.savedScript?.scriptId === scriptId, scriptId, receipt.savedScript?.scriptId ?? null);
        require("same_revision", receipt.savedScript?.revision === row.revision, row.revision, receipt.savedScript?.revision ?? null);
        require("same_code_hash", receipt.codeHash === row.codeHash && receipt.savedScript?.codeHash === row.codeHash, row.codeHash, receipt.codeHash);
        require("succeeded", receipt.status === "succeeded", "succeeded", receipt.status);
        require("has_checks", Array.isArray(receipt.checks) && receipt.checks.length > 0, "at least one check", receipt.checks?.length ?? 0);
        const failed = (receipt.checks || []).filter(check => check.passed !== true).map(check => check.name);
        require("checks_passed", failed.length === 0, "every check passed", failed);
        require("document_kind", receipt.document?.kind === row.documentKind, row.documentKind, receipt.document?.kind ?? null);
      }
      if (unmet.length > 0) return { status: "rejected", script: summarize(row), unmet };
      const promotedAt = new Date().toISOString();
      await library.writeState(row, {
        state: "active",
        promotedAt,
        promotionRunId: runId,
        promotionEvidence: {
          runId,
          codeHash: receipt.codeHash,
          documentKind: receipt.document.kind,
          documentPath: receipt.document.path ?? null,
          revitVersion: receipt.session?.version ?? null,
          checks: receipt.checks,
          completedAt: receipt.completedAt,
        },
      });
      return { status: "promoted", script: summarize(await library.readRevision(scriptId, row.revision)), unmet: [] };
    });
  }

  async retire({ scriptId, revision, reason }) {
    const library = await this.library();
    return this.exclusive(async () => {
      const row = await library.get(scriptId, revision);
      if (row.state === "retired") throw libraryError("ALREADY_RETIRED", `Script ${scriptId} revision ${row.revision} is already retired.`);
      const current = await readJson(path.join(library.scriptDirectory(scriptId), `${row.revision}.state.json`)) || { state: "draft" };
      await library.writeState(row, {
        ...current,
        state: "retired",
        retiredFrom: row.state,
        retiredAt: new Date().toISOString(),
        retirementReason: reason || null,
      });
      return { status: "retired", script: summarize(await library.readRevision(scriptId, row.revision)) };
    });
  }
}
