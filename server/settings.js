import path from "node:path";
import { readJson, writeJsonAtomic } from "./store.js";

// Spec #15 "Time Limit and Long Jobs": the longest any single execute_script run may take, and so
// the longest Revit can be held at a stretch. The add-in reads the same file (DriveIt.Core
// ScriptTimeLimit) and bounds its hold with it whatever the server asks.
//
// The setting applies to future runs. A run's bound is fixed when the run starts, but its hold
// begins at its first bridge call, possibly after the setting was lowered. So lowering the limit
// also stores earlierLimitUntil: the latest moment a run started under the earlier limit can
// still be running. Until then the add-in lets a hold last to that moment, so a lower setting
// never shortens a run already in progress.
export const DEFAULT_SCRIPT_TIME_LIMIT_SECONDS = 120;
export const MIN_SCRIPT_TIME_LIMIT_SECONDS = 10;
export const MAX_SCRIPT_TIME_LIMIT_SECONDS = 600;
export const DEFAULT_RUN_TIMEOUT_MS = 30000;
export const EARLIER_LIMIT_UNTIL = "earlierLimitUntil";

function validLimit(value) {
  return Number.isInteger(value) && value >= MIN_SCRIPT_TIME_LIMIT_SECONDS && value <= MAX_SCRIPT_TIME_LIMIT_SECONDS;
}

export class SettingsStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "settings.json");
  }

  // The stored object; a missing or malformed file reads as empty, as the add-in reads it.
  async stored() {
    try {
      const stored = await readJson(this.file);
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    } catch (error) {
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async get() {
    const limit = (await this.stored()).scriptTimeLimitSeconds;
    // A missing, malformed or hand-edited out-of-range value reads as the default, never as "no limit".
    return { scriptTimeLimitSeconds: validLimit(limit) ? limit : DEFAULT_SCRIPT_TIME_LIMIT_SECONDS };
  }

  async setScriptTimeLimitSeconds(value) {
    const seconds = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (!validLimit(seconds)) {
      const error = new Error(`The script time limit must be a whole number of seconds from ${MIN_SCRIPT_TIME_LIMIT_SECONDS} to ${MAX_SCRIPT_TIME_LIMIT_SECONDS}.`);
      error.code = "INVALID_SETTING";
      throw error;
    }
    const stored = await this.stored();
    const { scriptTimeLimitSeconds: previous } = await this.get();
    const now = Date.now();
    // Runs started under the earlier limit end by now + that limit; keep the later of that and any
    // moment an even earlier change still covers.
    const earlier = Date.parse(stored[EARLIER_LIMIT_UNTIL]);
    const until = Math.max(Number.isNaN(earlier) ? 0 : earlier, seconds < previous ? now + previous * 1000 : 0);
    const next = { ...stored, scriptTimeLimitSeconds: seconds };
    if (until > now) next[EARLIER_LIMIT_UNTIL] = new Date(until).toISOString();
    else delete next[EARLIER_LIMIT_UNTIL];
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
