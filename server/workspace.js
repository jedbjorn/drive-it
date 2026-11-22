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

export class WorkspacePolicy {
  constructor(decisions) {
    this.decisions = decisions;
  }

  async authorize(runId, requests, root) {
    const canonical = [];
    for (const request of requests) {
      const paths = [];
      for (const target of request.paths) paths.push(await canonicalPath(target));
      canonical.push({ operation: request.operation, paths });
    }
    const outside = canonical.filter(request => request.paths.some(target =>
      !pathIsInside(root, scopePath(request.operation, target, root, path), path)));
    if (outside.length === 0) return { status: "allowed", requests: canonical, root };

    const decision = await this.decisions.request(runId, outside);
    if (decision.status === "pending" || decision.status === "denied") {
      return { status: decision.status, decisionId: decision.id, requests: canonical, policyRequests: outside, root };
    }
    await this.decisions.consume(decision.id);
    return {
      status: "approved",
      decisionId: decision.id,
      grants: outside,
      requests: canonical,
      root,
    };
  }
}
