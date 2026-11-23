import path from "node:path";
import { randomUUID } from "node:crypto";
import { listJson, readJson, writeJsonAtomic } from "./store.js";

function requestFingerprint(requests) {
  return JSON.stringify(requests.map(request => ({
    operation: request.operation,
    paths: [...request.paths].sort(),
  })).sort((a, b) => a.operation.localeCompare(b.operation)));
}

export class DecisionStore {
  constructor(dataDir) {
    this.directory = path.join(dataDir, "decisions");
  }

  file(id) {
    return path.join(this.directory, `${id}.json`);
  }

  async get(id) {
    return readJson(this.file(id));
  }

  async list() {
    const rows = await listJson(this.directory);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async request(runId, requests, displayName = null) {
    const fingerprint = requestFingerprint(requests);
    const existing = (await this.list()).find(row => row.runId === runId
      && row.fingerprint === fingerprint && row.status !== "consumed");
    if (existing) return existing;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      runId,
      displayName,
      fingerprint,
      requests,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(this.file(row.id), row);
    return row;
  }

  async decide(id, approved) {
    const row = await this.get(id);
    if (!row) throw new Error(`Unknown outside-root decision: ${id}`);
    if (row.status !== "pending") throw new Error(`Decision ${id} is ${row.status}.`);
    row.status = approved ? "approved" : "denied";
    row.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file(id), row);
    return row;
  }

  async consume(id) {
    const row = await this.get(id);
    if (!row || row.status !== "approved") throw new Error(`Decision ${id} is not approved for use.`);
    row.status = "consumed";
    row.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file(id), row);
  }
}
