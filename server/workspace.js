import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "./store.js";

export async function canonicalPath(target, pathImpl = path) {
  const absolute = pathImpl.resolve(target);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = pathImpl.dirname(absolute);
    if (parent === absolute) throw error;
    const canonicalParent = await canonicalPath(parent, pathImpl);
    return pathImpl.join(canonicalParent, pathImpl.basename(absolute));
  }
}

export function pathIsInside(root, target, pathImpl = path) {
  const relative = pathImpl.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathImpl.sep}`) && !pathImpl.isAbsolute(relative));
}

function scopePath(operation, target, root, pathImpl) {
  const actsOnParent = /^(delete|rename|move)/.test(operation);
  return actsOnParent && pathImpl.relative(root, target) === "" ? pathImpl.dirname(target) : target;
}

export class WorkspaceStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "workspace.json");
  }

  async getRoot() {
    const config = await readJson(this.file);
    if (!config?.root) {
      const error = new Error("Select a Drive It workspace root before executing scripts.");
      error.code = "WORKSPACE_NOT_SELECTED";
      throw error;
    }
    return canonicalPath(config.root);
  }

  async setRoot(root) {
    const canonical = await canonicalPath(root);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("The workspace root must be a directory.");
    await writeJsonAtomic(this.file, { root: canonical });
    return canonical;
  }
}

// Operations that only read the target (opening a document or using it as a template included).
const READ_ONLY = new Set(["read_file", "read_directory", "read_document", "open_document", "create_document"]);

export class WorkspacePolicy {
  constructor(decisions) {
    this.decisions = decisions;
  }

  async authorize(runId, requests, root, displayName = null, readableRoots = []) {
    const canonical = [];
    for (const request of requests) {
      const paths = [];
      for (const target of request.paths) paths.push(await canonicalPath(target));
      canonical.push({ operation: request.operation, paths });
    }
    const outside = canonical.filter(request => request.paths.some(target =>
      !pathIsInside(root, scopePath(request.operation, target, root, path), path)));
    if (outside.length === 0) return { status: "allowed", requests: canonical, root };

    // Reading Revit's own installed content needs no decision; it rides along as a grant.
    const readable = outside.filter(request => READ_ONLY.has(request.operation)
      && request.paths.every(target => readableRoots.some(folder => pathIsInside(folder, target))));
    const decided = outside.filter(request => !readable.includes(request));
    if (decided.length === 0) return { status: "allowed", requests: canonical, root, grants: readable };

    const decision = await this.decisions.request(runId, decided, displayName);
    if (decision.status === "pending" || decision.status === "denied") {
      return { status: decision.status, decisionId: decision.id, requests: canonical, policyRequests: decided, root };
    }
    await this.decisions.consume(decision.id);
    return {
      status: "approved",
      decisionId: decision.id,
      grants: [...decided, ...readable],
      requests: canonical,
      root,
    };
  }
}
