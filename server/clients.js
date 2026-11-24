// Registers the installed Drive It MCP server with the MCP clients found for the
// current user (Claude Desktop, Claude Code, Codex and the ChatGPT desktop app, which reads
// Codex's config.toml) and removes it again on uninstall. Only detected clients are touched;
// every other setting in their configuration is preserved.
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";

export const SERVER_NAME = "drive-it";
const BEGIN = "# BEGIN drive-it (managed by the Drive It installer)";
const END = "# END drive-it";
// Codex otherwise stops waiting at 60 s. execute_script runs for up to the script time limit, and
// capture_revit_view may wait out a 600 s hold first (server/capture.js BROKER_BUDGET).
export const CODEX_TOOL_TIMEOUT_SEC = 630;
// Codex allows 10 s by default; a first cold node.exe start under Defender scanning can take longer.
const CODEX_STARTUP_TIMEOUT_SEC = 30;

// The Microsoft Store (MSIX) build of Claude Desktop reads its configuration from
// <LocalAppData>\Claude-Data\claude_<publisher>\claude_desktop_config.json, a file the app
// also writes its own preferences into, and never reads %APPDATA%\Claude (observed with
// Claude 6.28899.6.0, which logged "Connected to drive-it" only from this location).
// LocalAppData is the Roaming folder's sibling.
async function storeClaudeDirectories(appData) {
  const root = path.join(path.dirname(appData), "Local", "Claude-Data");
  let names;
  try {
    names = await readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter(name => /^claude_[a-z0-9]+$/i.test(name)).map(name => path.join(root, name));
}

async function packages(appData, pattern) {
  const root = path.join(path.dirname(appData), "Local", "Packages");
  try {
    return (await readdir(root)).filter(name => pattern.test(name)).map(name => path.join(root, name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function clientTargets({ userProfile, appData, codexHome }) {
  const codex = codexHome || path.join(userProfile, ".codex");
  // A fresh ChatGPT desktop (Store) install may not have created ~/.codex yet; its package
  // is enough to create the file it will read.
  const chatgpt = await packages(appData, /^OpenAI\.(Codex|ChatGPT)/i);
  const desktop = directory => ({ client: "claude-desktop", detect: directory, file: path.join(directory, "claude_desktop_config.json"), format: "json" });
  return [
    desktop(path.join(appData, "Claude")),
    ...(await storeClaudeDirectories(appData)).map(desktop),
    { client: "claude-code", detect: path.join(userProfile, ".claude.json"), file: path.join(userProfile, ".claude.json"), format: "json", stdioType: true, cli: path.join(userProfile, ".local", "bin", "claude.exe") },
    { client: "codex", detect: codex, alsoDetect: chatgpt, file: path.join(codex, "config.toml"), format: "toml" },
  ];
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(file, text, original) {
  if (original !== null) await copyFile(file, `${file}.drive-it.bak`);
  const temporary = `${file}.drive-it-${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexBlock(entry) {
  const lines = [
    BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${(entry.args || []).map(tomlString).join(", ")}]`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
  ];
  const env = Object.entries(entry.env || {});
  if (env.length > 0) {
    lines.push("", `[mcp_servers.${SERVER_NAME}.env]`, ...env.map(([key, value]) => `${key} = ${tomlString(value)}`));
  }
  lines.push(END);
  return lines.join("\n");
}

function withoutManagedBlock(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END, start);
  if (start === -1 || end === -1) return { text, eol, found: false };
  lines.splice(start, end - start + 1);
  const rest = lines.join(eol).replace(/\s+$/, "");
  return { text: rest ? `${rest}${eol}` : "", eol, found: true };
}

function parseCodex(text, what) {
  try {
    return parseToml(text);
  } catch (error) {
    throw new Error(`${what} is not valid TOML (${error.message.split("\n")[0]}); leaving it unchanged`);
  }
}

// A malformed config.toml stops the ChatGPT/Codex desktop app at startup, so the result is
// parsed before it is written, and an existing file that does not parse is never touched.
export function addToCodexConfig(text, entry) {
  const stripped = withoutManagedBlock(text ?? "");
  const existing = parseCodex(stripped.text, "config.toml");
  if (existing.mcp_servers && Object.hasOwn(existing.mcp_servers, SERVER_NAME)) {
    throw new Error(`config.toml already defines mcp_servers.${SERVER_NAME} outside the Drive It block; leaving it unchanged`);
  }
  const body = stripped.text.replace(/\s+$/, "");
  const block = codexBlock(entry).split("\n").join(stripped.eol);
  const next = body ? `${body}${stripped.eol}${stripped.eol}${block}${stripped.eol}` : `${block}${stripped.eol}`;
  parseCodex(next, "The updated config.toml");
  return next;
}

export function removeFromCodexConfig(text) {
  const stripped = withoutManagedBlock(text);
  return stripped.found ? stripped.text : null;
}

export function addToJsonConfig(text, entry, { stdioType = false } = {}) {
  const configuration = text && text.trim() ? JSON.parse(text) : {};
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("the configuration is not a JSON object; leaving it unchanged");
  }
  if (configuration.mcpServers !== undefined && (configuration.mcpServers === null || typeof configuration.mcpServers !== "object")) {
    throw new Error("mcpServers is not a JSON object; leaving it unchanged");
  }
  configuration.mcpServers = {
    ...configuration.mcpServers,
    [SERVER_NAME]: stdioType ? { type: "stdio", ...entry } : { ...entry },
  };
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

export function removeFromJsonConfig(text) {
  const configuration = JSON.parse(text);
  if (!configuration?.mcpServers || !(SERVER_NAME in configuration.mcpServers)) return null;
  delete configuration.mcpServers[SERVER_NAME];
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

function run(file, args) {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 30000 },
    (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stderr: String(stderr || error?.message || "") })));
}

// Claude Code rewrites ~/.claude.json while it runs, so its own CLI is the safe writer when it
// is installed; the direct file edit remains the fallback.
async function registerWithClaudeCli(target, entry, runner) {
  if (!target.cli || !(await exists(target.cli))) return null;
  await runner(target.cli, ["mcp", "remove", "-s", "user", SERVER_NAME]);
  const added = await runner(target.cli, ["mcp", "add-json", "-s", "user", SERVER_NAME, JSON.stringify({ type: "stdio", ...entry })]);
  return added.code === 0 ? { client: target.client, status: "registered", file: target.file, via: "claude mcp add-json" } : null;
}

async function detected(target) {
  if (await exists(target.detect)) return true;
  if (target.cli && await exists(target.cli)) return true;
  return (target.alsoDetect || []).length > 0;
}

export async function registerClients(entry, locations, { runner = run } = {}) {
  const results = [];
  for (const target of await clientTargets(locations)) {
    if (!(await detected(target))) {
      results.push({ client: target.client, status: "not_found" });
      continue;
    }
    try {
      const viaCli = await registerWithClaudeCli(target, entry, runner);
      if (viaCli) {
        results.push(viaCli);
        continue;
      }
      await mkdir(path.dirname(target.file), { recursive: true });
      const original = await readText(target.file);
      const next = target.format === "toml"
        ? addToCodexConfig(original, entry)
        : addToJsonConfig(original, entry, target);
      if (next !== original) await writeAtomic(target.file, next, original);
      results.push({ client: target.client, status: "registered", file: target.file });
    } catch (error) {
      results.push({ client: target.client, status: "skipped", file: target.file, reason: error.message });
    }
  }
  return results;
}

export async function unregisterClients(locations, { runner = run } = {}) {
  const results = [];
  for (const target of await clientTargets(locations)) {
    try {
      if (target.cli && await exists(target.cli)) {
        const cliRemoved = await runner(target.cli, ["mcp", "remove", "-s", "user", SERVER_NAME]);
        if (cliRemoved.code === 0) {
          results.push({ client: target.client, status: "removed", file: target.file, via: "claude mcp remove" });
          continue;
        }
      }
      const original = await readText(target.file);
      const next = original === null ? null
        : target.format === "toml" ? removeFromCodexConfig(original) : removeFromJsonConfig(original);
      if (next === null) {
        results.push({ client: target.client, status: "not_registered" });
        continue;
      }
      await writeAtomic(target.file, next, original);
      results.push({ client: target.client, status: "removed", file: target.file });
    } catch (error) {
      results.push({ client: target.client, status: "skipped", file: target.file, reason: error.message });
    }
  }
  return results;
}

async function main(argv) {
  const [action, ...rest] = argv;
  if (action === "register" && rest.length >= 3) {
    const [mcpConfigPath, userProfile, appData, codexHome] = rest;
    const entry = JSON.parse(await readFile(mcpConfigPath, "utf8")).mcpServers?.[SERVER_NAME];
    if (!entry) throw new Error(`${mcpConfigPath} has no ${SERVER_NAME} server entry`);
    return registerClients(entry, { userProfile, appData, codexHome });
  }
  if (action === "unregister" && rest.length >= 2) {
    const [userProfile, appData, codexHome] = rest;
    return unregisterClients({ userProfile, appData, codexHome });
  }
  throw new Error("Usage: node server/clients.js register <mcp.json> <user-profile> <appdata> [codex-home] | unregister <user-profile> <appdata> [codex-home]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    results => console.log(JSON.stringify(results, null, 2)),
    error => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
