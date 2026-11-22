import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function listJson(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const rows = await Promise.all(names.filter(name => name.endsWith(".json"))
    .map(name => readJson(path.join(directory, name))));
  return rows.filter(Boolean);
}

export function defaultDataDir() {
  if (process.env.DRIVE_IT_DATA_DIR) return process.env.DRIVE_IT_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local"), "DriveIt");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || ".", ".local", "share"), "drive-it");
}
