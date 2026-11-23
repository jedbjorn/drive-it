import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { addToCodexConfig, registerClients, unregisterClients } from "../server/clients.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../server/clients.js", import.meta.url));
const entry = {
  command: String.raw`C:\Users\a b\AppData\Local\DriveIt\app\runtimes\node\node.exe`,
  args: [String.raw`C:\Users\a b\AppData\Local\DriveIt\app\server\index.js`],
  env: {
    DRIVE_IT_DATA_DIR: String.raw`C:\Users\a b\AppData\Local\DriveIt`,
    DRIVE_IT_PYTHON: String.raw`C:\Users\a b\AppData\Local\DriveIt\app\runtimes\python\python.exe`,
  },
};

async function profile(t) {
  const base = await mkdtemp(path.join(tmpdir(), "drive-it-clients-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const userProfile = path.join(base, "home");
  const appData = path.join(base, "roaming");
  await mkdir(userProfile);
  await mkdir(appData);
  return { base, userProfile, appData };
}

const exists = file => access(file).then(() => true, () => false);

test("only detected clients are registered and their other settings survive install and uninstall", async (t) => {
  const locations = await profile(t);
  const desktop = path.join(locations.appData, "Claude", "claude_desktop_config.json");
  const code = path.join(locations.userProfile, ".claude.json");
  const codex = path.join(locations.userProfile, ".codex", "config.toml");
  await mkdir(path.dirname(desktop));
  await mkdir(path.dirname(codex));
  const codeOriginal = { numStartups: 3, projects: { "C:/x": { allowedTools: [] } }, mcpServers: { other: { type: "stdio", command: "other.exe", args: [] } } };
  await writeFile(code, JSON.stringify(codeOriginal));
  const codexOriginal = 'model = "gpt-5"\r\n\r\n[mcp_servers.other]\r\ncommand = "other.exe"\r\n';
  await writeFile(codex, codexOriginal);

  const registered = await registerClients(entry, locations);
  assert.deepEqual(registered.map(r => [r.client, r.status]), [["claude-desktop", "registered"], ["claude-code", "registered"], ["codex", "registered"]]);

  assert.deepEqual(JSON.parse(await readFile(desktop, "utf8")), { mcpServers: { "drive-it": entry } });
  const codeConfig = JSON.parse(await readFile(code, "utf8"));
  assert.deepEqual(codeConfig.mcpServers["drive-it"], { type: "stdio", ...entry });
  assert.deepEqual(codeConfig.mcpServers.other, codeOriginal.mcpServers.other);
  assert.deepEqual(codeConfig.projects, codeOriginal.projects);
  assert.equal(await readFile(`${code}.drive-it.bak`, "utf8"), JSON.stringify(codeOriginal));

  const codexText = await readFile(codex, "utf8");
  assert.ok(codexText.startsWith(codexOriginal), "existing Codex settings must stay in place");
  assert.ok(codexText.includes('command = "C:\\\\Users\\\\a b\\\\AppData\\\\Local\\\\DriveIt\\\\app\\\\runtimes\\\\node\\\\node.exe"'));
  assert.ok(codexText.includes("[mcp_servers.drive-it.env]"));
  assert.ok(codexText.includes("tool_timeout_sec = 150"));
  assert.ok(!/[^\r]\n/.test(codexText), "the file's CRLF line endings are kept");

  const again = await registerClients(entry, locations);
  assert.ok(again.every(r => r.status === "registered"));
  assert.equal(await readFile(codex, "utf8"), codexText, "re-registration is idempotent");

  const removed = await unregisterClients(locations);
  assert.deepEqual(removed.map(r => r.status), ["removed", "removed", "removed"]);
  assert.deepEqual(JSON.parse(await readFile(desktop, "utf8")), { mcpServers: {} });
  assert.deepEqual(JSON.parse(await readFile(code, "utf8")), codeOriginal);
  assert.equal(await readFile(codex, "utf8"), codexOriginal);
  assert.deepEqual((await unregisterClients(locations)).map(r => r.status), ["not_registered", "not_registered", "not_registered"]);
});

test("missing clients are left alone and unreadable configurations are skipped, not rewritten", async (t) => {
  const locations = await profile(t);
  const code = path.join(locations.userProfile, ".claude.json");
  await writeFile(code, "{ not json");
  const results = await registerClients(entry, locations);
  assert.deepEqual(results.map(r => [r.client, r.status]), [["claude-desktop", "not_found"], ["claude-code", "skipped"], ["codex", "not_found"]]);
  assert.equal(await readFile(code, "utf8"), "{ not json");
  assert.equal(await exists(path.join(locations.appData, "Claude")), false);
  assert.equal(await exists(path.join(locations.userProfile, ".codex")), false);
});

test("a hand-written Codex drive-it table is never duplicated", () => {
  assert.throws(() => addToCodexConfig('[mcp_servers.drive-it]\ncommand = "mine.exe"\n', entry), /outside the Drive It block/);
  assert.throws(() => addToCodexConfig('[mcp_servers."drive-it".env]\nX = "1"\n', entry), /outside the Drive It block/);
  assert.ok(addToCodexConfig("", entry).startsWith("# BEGIN drive-it"));
});

test("the CLI registers from the installer's mcp.json and honours CODEX_HOME", async (t) => {
  const locations = await profile(t);
  const codexHome = path.join(locations.base, "codex-home");
  await mkdir(codexHome);
  const mcp = path.join(locations.base, "mcp.json");
  await writeFile(mcp, JSON.stringify({ mcpServers: { "drive-it": entry } }));
  const { stdout } = await execute(process.execPath, [cli, "register", mcp, locations.userProfile, locations.appData, codexHome]);
  assert.deepEqual(JSON.parse(stdout).map(r => r.status), ["not_found", "not_found", "registered"]);
  assert.ok((await readFile(path.join(codexHome, "config.toml"), "utf8")).includes("[mcp_servers.drive-it]"));
  const { stdout: removed } = await execute(process.execPath, [cli, "unregister", locations.userProfile, locations.appData, codexHome]);
  assert.deepEqual(JSON.parse(removed).map(r => r.status), ["not_registered", "not_registered", "removed"]);
});

test("the Microsoft Store Claude Desktop is registered inside its package data", async (t) => {
  const locations = await profile(t);
  const packages = path.join(locations.base, "Local", "Packages");
  const store = path.join(packages, "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
  await mkdir(store, { recursive: true });
  await mkdir(path.join(packages, "ClaudeHelper_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude"), { recursive: true });
  const config = path.join(store, "claude_desktop_config.json");

  const registered = await registerClients(entry, locations);
  assert.deepEqual(registered.filter(row => row.status === "registered").map(row => row.file), [config]);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).mcpServers["drive-it"], entry);
  assert.equal(await exists(path.join(locations.appData, "Claude")), false);

  const removed = await unregisterClients(locations);
  assert.deepEqual(removed.filter(row => row.status === "removed").map(row => row.file), [config]);
  assert.equal("drive-it" in JSON.parse(await readFile(config, "utf8")).mcpServers, false);
});
