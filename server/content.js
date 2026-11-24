// Revit's installed content (project templates, family templates, libraries) under
// %ProgramData%\Autodesk\RVT <version>, so an agent can name a real template instead of guessing.
// The version is the session's (2026 or 2027); with none known there is no content folder.
import { readdir } from "node:fs/promises";
import path from "node:path";

async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function subdirectories(directory) {
  return (await entries(directory)).filter(entry => entry.isDirectory()).map(entry => path.join(directory, entry.name));
}

function contentRoot(version, programData) {
  return path.join(programData || process.env.ProgramData || String.raw`C:\ProgramData`, "Autodesk", `RVT ${version}`);
}

// Folders Revit installs its own content into; Drive It reads these without a decision.
export function revitContentFolders(version, programData) {
  if (!version) return [];
  const root = contentRoot(version, programData);
  return ["Templates", "Family Templates", "Libraries"].map(name => path.join(root, name));
}

export async function revitContent(version, programData) {
  const projectTemplates = [];
  if (!version) return { projectTemplates, familyTemplateFolders: [], libraryFolders: [] };
  const root = contentRoot(version, programData);
  for (const folder of await subdirectories(path.join(root, "Templates"))) {
    for (const entry of await entries(folder)) {
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".rte") projectTemplates.push(path.join(folder, entry.name));
    }
  }
  return {
    projectTemplates: projectTemplates.sort(),
    familyTemplateFolders: (await subdirectories(path.join(root, "Family Templates"))).sort(),
    libraryFolders: (await subdirectories(path.join(root, "Libraries"))).sort(),
  };
}
