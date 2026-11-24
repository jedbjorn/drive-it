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
  assert.ok(codexText.includes("tool_timeout_sec = 630"));
  assert.ok(codexText.includes("startup_timeout_sec = 30"));
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

test("a hand-written Codex drive-it entry in any TOML form is never duplicated", () => {
  assert.throws(() => addToCodexConfig('[mcp_servers.drive-it]\ncommand = "mine.exe"\n', entry), /outside the Drive It block/);
  assert.throws(() => addToCodexConfig('[mcp_servers."drive-it".env]\nX = "1"\n', entry), /outside the Drive It block/);
  assert.throws(() => addToCodexConfig('mcp_servers = { "drive-it" = { command = "mine.exe" } }\n', entry), /outside the Drive It block/);
  assert.throws(() => addToCodexConfig('[mcp_servers]\ndrive-it.command = "mine.exe"\n', entry), /outside the Drive It block/);
  assert.ok(addToCodexConfig("", entry).startsWith("# BEGIN drive-it"));
});

test("a Codex config.toml that does not parse is skipped and left byte-for-byte unchanged", async (t) => {
  const locations = await profile(t);
  const codex = path.join(locations.userProfile, ".codex", "config.toml");
  await mkdir(path.dirname(codex));
  const broken = 'model = "gpt-5\n[mcp_servers.other\n';
  await writeFile(codex, broken);
  const results = await registerClients(entry, locations);
  const row = results.find(r => r.client === "codex");
  assert.equal(row.status, "skipped");
  assert.match(row.reason, /not valid TOML/);
  assert.equal(await readFile(codex, "utf8"), broken);
  assert.equal(await exists(`${codex}.drive-it.bak`), false);
});

test("the ChatGPT desktop app's Store package creates the Codex config.toml it reads", async (t) => {
  const locations = await profile(t);
  await mkdir(path.join(locations.base, "Local", "Packages", "OpenAI.Codex_2p2nqsd0c76g0"), { recursive: true });
  const results = await registerClients(entry, locations);
  assert.deepEqual(results.find(r => r.client === "codex").status, "registered");
  const text = await readFile(path.join(locations.userProfile, ".codex", "config.toml"), "utf8");
  assert.ok(text.includes("[mcp_servers.drive-it]"));
  assert.deepEqual((await unregisterClients(locations)).find(r => r.client === "codex").status, "removed");
});

test("Claude Code is registered through its own CLI when installed, falling back to the file", async (t) => {
  const locations = await profile(t);
  const claude = path.join(locations.userProfile, ".local", "bin", "claude.exe");
  await mkdir(path.dirname(claude), { recursive: true });
  await writeFile(claude, "");
  const calls = [];
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stderr: "" };
  };

  const registered = await registerClients(entry, locations, { runner });
  const row = registered.find(r => r.client === "claude-code");
  assert.equal(row.status, "registered");
  assert.equal(row.via, "claude mcp add-json");
  assert.deepEqual(calls[0], [claude, "mcp", "remove", "-s", "user", "drive-it"]);
  assert.deepEqual(calls[1].slice(0, 6), [claude, "mcp", "add-json", "-s", "user", "drive-it"]);
  assert.deepEqual(JSON.parse(calls[1][6]), { type: "stdio", ...entry });
  assert.equal(await exists(path.join(locations.userProfile, ".claude.json")), false, "the CLI owns the file");

  const removed = await unregisterClients(locations, { runner });
  assert.equal(removed.find(r => r.client === "claude-code").status, "removed");
  assert.deepEqual(calls.at(-1), [claude, "mcp", "remove", "-s", "user", "drive-it"]);

  const failing = async () => ({ code: 1, stderr: "boom" });
  const fallback = await registerClients(entry, locations, { runner: failing });
  assert.equal(fallback.find(r => r.client === "claude-code").via, undefined);
  const written = JSON.parse(await readFile(path.join(locations.userProfile, ".claude.json"), "utf8"));
  assert.deepEqual(written.mcpServers["drive-it"], { type: "stdio", ...entry });
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

test("the Microsoft Store Claude Desktop is registered in its Claude-Data configuration", async (t) => {
  const locations = await profile(t);
  const data = path.join(locations.base, "Local", "Claude-Data");
  const store = path.join(data, "claude_pzs8sxrjxfjjc");
  await mkdir(store, { recursive: true });
  await mkdir(path.join(data, "claude-helper_pzs8sxrjxfjjc"), { recursive: true });
  const config = path.join(store, "claude_desktop_config.json");
  await writeFile(config, JSON.stringify({ coworkUserFilesPath: "x", preferences: { sidebarMode: "a" } }));

  const registered = await registerClients(entry, locations);
  assert.deepEqual(registered.filter(row => row.status === "registered").map(row => row.file), [config]);
  const written = JSON.parse(await readFile(config, "utf8"));
  assert.deepEqual(written.mcpServers["drive-it"], entry);
  assert.deepEqual(written.preferences, { sidebarMode: "a" });
  assert.equal(await exists(path.join(locations.appData, "Claude")), false);

  const removed = await unregisterClients(locations);
  assert.deepEqual(removed.filter(row => row.status === "removed").map(row => row.file), [config]);
  assert.equal("drive-it" in JSON.parse(await readFile(config, "utf8")).mcpServers, false);
});
