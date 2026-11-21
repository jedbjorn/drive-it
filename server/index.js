import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const processId = z.number().int().positive().max(0xffffffff);
const session = z.object({ processId, version: z.string(), build: z.string() });

async function readSession(pid) {
  if (process.platform !== "win32") {
    throw new Error("Run the MCP server on the Windows machine hosting Revit.");
  }

  const pipe = createConnection(String.raw`\\.\pipe\drive-it-${pid}`);
  const timeout = setTimeout(() => pipe.destroy(new Error("Revit connection timed out.")), 4000);
  try {
    let message = "";
    pipe.setEncoding("utf8");
    for await (const chunk of pipe) {
      message += chunk;
      if (message.length > 4096) throw new Error("Revit session response is too large.");
      if (message.includes("\n")) {
        const info = session.parse(JSON.parse(message));
        if (info.processId !== pid) throw new Error("Unexpected Revit process ID.");
        return info;
      }
    }
    throw new Error("Revit disconnected before sending its session details.");
  } finally {
    clearTimeout(timeout);
    pipe.destroy();
  }
}

const server = new McpServer({ name: "drive-it", version: "0.1.0" });
server.registerTool("get_revit_session", {
  description: "Read the Revit version and build from a running Drive It add-in.",
  inputSchema: { processId: processId.describe("Windows process ID of Revit.exe") },
  outputSchema: session.shape,
  annotations: { readOnlyHint: true },
}, async ({ processId }) => {
  try {
    const info = await readSession(processId);
    return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
  } catch (error) {
    const reason = error.code === "ENOENT"
      ? "Check the Revit process ID and that the Drive It add-in is loaded."
      : error.message;
    return { isError: true, content: [{ type: "text", text: reason }] };
  }
});

await server.connect(new StdioServerTransport());
