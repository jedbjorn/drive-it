import os from "node:os";
import path from "node:path";
import { detectClients } from "./clients.js";
import { DecisionStore } from "./decisions.js";
import { HistoryStore } from "./history.js";
import { SettingsStore } from "./settings.js";
import { stagedDryRun } from "./staged.js";
import { defaultDataDir } from "./store.js";
import { WorkspaceStore } from "./workspace.js";

const dataDir = defaultDataDir();
const workspace = new WorkspaceStore(dataDir);
const decisions = new DecisionStore(dataDir);
const history = new HistoryStore(dataDir);
const settings = new SettingsStore(dataDir);
const [area, action, value] = process.argv.slice(2);

// Detect agents: the installer's client registration for the current Windows user, from the
// mcp.json the window names (else DRIVE_IT_MCP_CONFIG_PATH, else the install's own beside the data).
function detect(mcpConfigPath) {
  const userProfile = process.env.USERPROFILE || os.homedir();
  return detectClients(mcpConfigPath || process.env.DRIVE_IT_MCP_CONFIG_PATH || path.join(dataDir, "mcp.json"), {
    userProfile,
    appData: process.env.APPDATA || path.join(userProfile, "AppData", "Roaming"),
    codexHome: process.env.CODEX_HOME || undefined,
  });
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

try {
  if (area === "workspace" && action === "get") print({ root: await workspace.getRoot() });
  else if (area === "workspace" && action === "set" && value) print({ root: await workspace.setRoot(value) });
  else if (area === "decisions" && action === "list") print(await decisions.list());
  else if (area === "decisions" && ["approve", "deny"].includes(action) && value) print(await decisions.decide(value, action === "approve"));
  else if (area === "history" && action === "list") print(await history.list());
  else if (area === "history" && action === "get" && value) print(await history.get(value));
  else if (area === "settings" && action === "get") print({ ...await settings.get(), requireDryRun: await settings.requireDryRun() });
  else if (area === "settings" && action === "set-time-limit" && value) print(await settings.setScriptTimeLimitSeconds(value));
  else if (area === "settings" && action === "set-require-dry-run" && value) print(await settings.setRequireDryRun(value));
  else if (area === "staged" && action === "get") print(await stagedDryRun(history, await workspace.getRoot().catch(() => null)));
  else if (area === "clients" && action === "detect") print(await detect(value));
  else {
    console.error("Usage: node server/operator.js workspace get|set [path] | decisions list|approve|deny [id] | history list|get [runId] | settings get|set-time-limit [seconds]|set-require-dry-run on|off | staged get | clients detect [mcp.json]");
    process.exitCode = 2;
  }
} catch (error) {
  // Node's own errors already begin with their code ("EACCES: permission denied, open ..."); say it once.
  const code = error.code || "OPERATOR_COMMAND_FAILED";
  console.error(String(error.message).startsWith(`${code}:`) ? error.message : `${code}: ${error.message}`);
  process.exitCode = 1;
}
