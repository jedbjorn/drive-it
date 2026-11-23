// Revit's installed content (project templates, family templates, libraries) under
// %ProgramData%\Autodesk\RVT <version>, so an agent can name a real template instead of guessing.
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

export async function revitContent(version = "2026", programData = process.env.ProgramData || String.raw`C:\ProgramData`) {
  const root = path.join(programData, "Autodesk", `RVT ${version}`);
  const projectTemplates = [];
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
