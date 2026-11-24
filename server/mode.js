// The install mode (spec #10 "Mode Selection"): Node's one mode resolver, and the only place the
// server, the worker launch and the installer learn the mode. DriveIt.Core's InstallMode is the
// add-in's and the Drive-It window's twin; both read the same two install-owned files the same way.
//
//   1. User mode file   %LOCALAPPDATA%\DriveIt\install-mode.json  { "mode": "dev" | "standard" }
//                       written by every install (installer/Install-DriveIt.ps1).
//   2. Admin marker     %ProgramData%\DriveIt\dev-mode\<user-SID>.json  { "mode": "dev", "sid": "<SID>" }
//                       written only by an elevated dev install, owned by Administrators.
//
// The mode is "dev" only when the user file says dev AND this user's marker exists, is owned by
// SYSTEM or Administrators (a standard user cannot create such a file, though Users may create
// files under %ProgramData%), and names this user's SID. Anything else, including any failure to
// read or check either file, is "standard". No MCP request, tool argument, script or mode variable
// is consulted. The paths come from the process environment like every other Drive-It path
// (DRIVE_IT_PYTHON already names the interpreter); the admin-owned marker is what a standard user
// cannot supply.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STANDARD = "standard";
export const DEV = "dev";
export const USER_MODE_FILE = "install-mode.json";
// SYSTEM and BUILTIN\Administrators: the owners an elevated install leaves on the marker.
export const TRUSTED_MARKER_OWNERS = Object.freeze(["S-1-5-18", "S-1-5-32-544"]);

/** The user mode file and the admin marker directory for this Windows user. */
export function modePaths(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || "C:\\", "AppData", "Local");
  const programData = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
  return {
    userFile: path.win32.join(localAppData, "DriveIt", USER_MODE_FILE),
    markerDirectory: path.win32.join(programData, "DriveIt", "dev-mode"),
  };
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Why the user file alone yields standard, or null when it asks for dev.
function userFileRefusal(userFileText) {
  if (userFileText === null || userFileText === undefined) return "no user mode file";
  const user = parseObject(userFileText);
  if (!user) return "the user mode file is not a JSON object";
  if (user.mode !== DEV) return `the user mode file says ${JSON.stringify(user.mode ?? null)}`;
  return null;
}

/**
 * The rule itself, with no I/O. userFileText: the user file's text or null. marker: { sid, owner,
 * text } for this user's marker (owner and text null when it does not exist), or null when it was
 * not or could not be checked. Returns { mode, reason }.
 */
export function decideMode(userFileText, marker) {
  const refusal = userFileRefusal(userFileText);
  if (refusal) return { mode: STANDARD, reason: refusal };
  if (!marker?.sid) return { mode: STANDARD, reason: "the admin marker could not be checked" };
  if (marker.text === null || marker.text === undefined) return { mode: STANDARD, reason: `no admin marker for ${marker.sid}` };
  if (!TRUSTED_MARKER_OWNERS.includes(marker.owner)) {
    return { mode: STANDARD, reason: `the admin marker is owned by ${marker.owner ?? "nobody"}, not SYSTEM or Administrators` };
  }
  const content = parseObject(marker.text);
  if (content?.mode !== DEV || content.sid !== marker.sid) {
    return { mode: STANDARD, reason: `the admin marker is not a dev marker for ${marker.sid}` };
  }
  return { mode: DEV, reason: `the user mode file and the admin marker for ${marker.sid} say dev` };
}

// One Windows PowerShell call: this user's SID, and the owner and text of that user's marker.
const INSPECT_MARKER = `$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$path = Join-Path $env:DRIVE_IT_DEV_MARKER_DIRECTORY ($sid + '.json')
$result = [ordered]@{ sid = $sid; owner = $null; text = $null }
if ([IO.File]::Exists($path)) {
    $result.owner = (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    $result.text = [IO.File]::ReadAllText($path)
}
$result | ConvertTo-Json -Compress`;

/** { sid, owner, text } for the current Windows user's marker in markerDirectory. */
export function inspectMarker(markerDirectory, env = process.env) {
  const powershell = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(INSPECT_MARKER, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      env: { ...env, DRIVE_IT_DEV_MARKER_DIRECTORY: markerDirectory },
      timeout: 20000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolves the mode for this process's Windows user: { mode, reason }. Never throws; every failure
 * is standard. Off Windows the mode is always standard. The options replace the machine in tests.
 */
export async function resolveMode({
  platform = process.platform,
  env = process.env,
  readUserFile = readText,
  inspect = inspectMarker,
} = {}) {
  if (platform !== "win32") return { mode: STANDARD, reason: "Dev Mode exists only on Windows" };
  try {
    const { userFile, markerDirectory } = modePaths(env);
    const userFileText = await readUserFile(userFile);
    // The marker check costs a PowerShell start, so it runs only when the user file asks for dev.
    if (userFileRefusal(userFileText)) return decideMode(userFileText, null);
    return decideMode(userFileText, await inspect(markerDirectory, env));
  } catch (error) {
    return { mode: STANDARD, reason: `the mode could not be resolved: ${error.message}` };
  }
}

let resolved;

/** This process's mode, "dev" or "standard", resolved once: it changes only by reinstalling. */
export function installMode() {
  resolved ??= resolveMode().then(result => result.mode);
  return resolved;
}

// `node server/mode.js` prints { mode, reason }; the installer reads the recorded mode with it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await resolveMode()));
}
