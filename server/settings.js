import path from "node:path";
import { readJson, writeJsonAtomic } from "./store.js";

// Spec #15 "Time Limit and Long Jobs": the longest any single execute_script run may take, and so
// the longest Revit can be held at a stretch. The add-in reads the same file (DriveIt.Core
// ScriptTimeLimit) and bounds its hold with it whatever the server asks.
export const DEFAULT_SCRIPT_TIME_LIMIT_SECONDS = 120;
export const MIN_SCRIPT_TIME_LIMIT_SECONDS = 10;
export const MAX_SCRIPT_TIME_LIMIT_SECONDS = 600;
export const DEFAULT_RUN_TIMEOUT_MS = 30000;

function validLimit(value) {
  return Number.isInteger(value) && value >= MIN_SCRIPT_TIME_LIMIT_SECONDS && value <= MAX_SCRIPT_TIME_LIMIT_SECONDS;
}

export class SettingsStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "settings.json");
  }

  async get() {
    const stored = await readJson(this.file);
    const limit = stored?.scriptTimeLimitSeconds;
    // A missing or hand-edited out-of-range value reads as the default, never as "no limit".
    return { scriptTimeLimitSeconds: validLimit(limit) ? limit : DEFAULT_SCRIPT_TIME_LIMIT_SECONDS };
  }

  async setScriptTimeLimitSeconds(value) {
    const seconds = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (!validLimit(seconds)) {
      const error = new Error(`The script time limit must be a whole number of seconds from ${MIN_SCRIPT_TIME_LIMIT_SECONDS} to ${MAX_SCRIPT_TIME_LIMIT_SECONDS}.`);
      error.code = "INVALID_SETTING";
      throw error;
    }
    const stored = (await readJson(this.file)) || {};
    const next = { ...stored, scriptTimeLimitSeconds: seconds };
    await writeJsonAtomic(this.file, next);
    return { scriptTimeLimitSeconds: seconds };
  }

  // The run's timeout: the agent's timeoutMs when given, else 30 s; never above the setting.
  async runTimeoutMs(requested) {
    const { scriptTimeLimitSeconds } = await this.get();
    const limitMs = scriptTimeLimitSeconds * 1000;
    if (requested === undefined || requested === null) return Math.min(DEFAULT_RUN_TIMEOUT_MS, limitMs);
    if (requested > limitMs) {
      const error = new Error(`timeoutMs ${requested} is above the script time limit of ${scriptTimeLimitSeconds} seconds (${limitMs} ms) set in the Drive-It window. Pass timeoutMs of ${limitMs} or less, or split the work into several scripts; the user can raise the limit in the Drive-It window.`);
      error.code = "TIMEOUT_ABOVE_LIMIT";
      throw error;
    }
    return requested;
  }
}
