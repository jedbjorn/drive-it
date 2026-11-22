import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [serverPath, dataDirectory, pythonPath, processId] = process.argv.slice(2);
if (!serverPath || !dataDirectory || !pythonPath) {
  throw new Error("Usage: node install-smoke.mjs <server-path> <data-directory> <python-path> [revit-process-id]");
}

const client = new Client({ name: "drive-it-installer", version: "1" });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, DRIVE_IT_DATA_DIR: dataDirectory, DRIVE_IT_PYTHON: pythonPath },
    stderr: "pipe",
  }));
  const { tools } = await client.listTools();
  if (!tools.some(tool => tool.name === "get_revit_session")) {
    throw new Error("The installed MCP server did not expose get_revit_session.");
  }
  if (processId) {
    const result = await client.callTool({
      name: "get_revit_session",
      arguments: { processId: Number(processId) },
    });
    if (result.isError) {
      throw new Error(result.content[0].text);
    }
    console.log(JSON.stringify(result.structuredContent));
  }
} finally {
  await client.close();
}
