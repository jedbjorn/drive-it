import path from "node:path";
import { listJson, readJson, writeJsonAtomic } from "./store.js";

export class HistoryStore {
  constructor(dataDir) {
    this.directory = path.join(dataDir, "runs");
  }

  file(runId) {
    return path.join(this.directory, `${runId}.json`);
  }

  async get(runId) {
    return readJson(this.file(runId));
  }

  async save(receipt) {
    await writeJsonAtomic(this.file(receipt.runId), receipt);
    return receipt;
  }

  async list() {
    const rows = await listJson(this.directory);
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async findIdempotent(idempotencyKey) {
    return (await this.list()).find(row => row.idempotencyKey === idempotencyKey) || null;
  }
}
