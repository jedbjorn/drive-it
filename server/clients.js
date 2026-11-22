// Registers the installed Drive It MCP server with the MCP clients found for the
// current user (Claude Desktop, Claude Code, Codex) and removes it again on uninstall.
// Only clients whose configuration location already exists are touched; every other
// setting in their configuration is preserved.
import { copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SERVER_NAME = "drive-it";
const BEGIN = "# BEGIN drive-it (managed by the Drive It installer)";
const END = "# END drive-it";
// execute_script accepts runs of up to 120 s; Codex otherwise stops waiting at 60 s.
const CODEX_TOOL_TIMEOUT_SEC = 150;

export function clientTargets({ userProfile, appData, codexHome }) {
  const codex = codexHome || path.join(userProfile, ".codex");
  return [
    { client: "claude-desktop", detect: path.join(appData, "Claude"), file: path.join(appData, "Claude", "claude_desktop_config.json"), format: "json" },
    { client: "claude-code", detect: path.join(userProfile, ".claude.json"), file: path.join(userProfile, ".claude.json"), format: "json", stdioType: true },
    { client: "codex", detect: codex, file: path.join(codex, "config.toml"), format: "toml" },
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

function hasUnmanagedCodexEntry(text) {
  const table = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${SERVER_NAME}\\1\\s*[\\].]`, "m");
  return table.test(text);
}

export function addToCodexConfig(text, entry) {
  const stripped = withoutManagedBlock(text ?? "");
  if (hasUnmanagedCodexEntry(stripped.text)) {
    throw new Error(`config.toml already defines [mcp_servers.${SERVER_NAME}] outside the Drive It block; leaving it unchanged`);
  }
  const body = stripped.text.replace(/\s+$/, "");
  const block = codexBlock(entry).split("\n").join(stripped.eol);
  return body ? `${body}${stripped.eol}${stripped.eol}${block}${stripped.eol}` : `${block}${stripped.eol}`;
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

export async function registerClients(entry, locations) {
  const results = [];
  for (const target of clientTargets(locations)) {
    if (!(await exists(target.detect))) {
      results.push({ client: target.client, status: "not_found" });
      continue;
    }
    try {
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

export async function unregisterClients(locations) {
  const results = [];
  for (const target of clientTargets(locations)) {
    try {
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
