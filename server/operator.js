import { DecisionStore } from "./decisions.js";
import { HistoryStore } from "./history.js";
import { SettingsStore } from "./settings.js";
import { defaultDataDir } from "./store.js";
import { WorkspaceStore } from "./workspace.js";

const dataDir = defaultDataDir();
const workspace = new WorkspaceStore(dataDir);
const decisions = new DecisionStore(dataDir);
const history = new HistoryStore(dataDir);
const settings = new SettingsStore(dataDir);
const [area, action, value] = process.argv.slice(2);

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
  else if (area === "settings" && action === "get") print(await settings.get());
  else if (area === "settings" && action === "set-time-limit" && value) print(await settings.setScriptTimeLimitSeconds(value));
  else {
    console.error("Usage: node server/operator.js workspace get|set [path] | decisions list|approve|deny [id] | history list|get [runId] | settings get|set-time-limit [seconds]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`${error.code || "OPERATOR_COMMAND_FAILED"}: ${error.message}`);
  process.exitCode = 1;
}
