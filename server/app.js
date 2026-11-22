import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiReference, API_VERSION } from "./reference.js";
import { Runtime } from "./runtime.js";
import { readSession, sessionError } from "./session.js";
import { defaultDataDir } from "./store.js";

const processId = z.number().int().positive().max(0xffffffff);
const document = z.object({
  path: z.string().min(1).nullable().optional(),
  uniqueId: z.string().min(1).nullable().optional(),
  kind: z.enum(["rvt", "rfa", "unknown"]).optional(),
});
const receiptStatus = z.enum(["pending", "denied", "failed", "timed_out", "partially_applied", "succeeded"]);

export function createDriveItServer(options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  const runtime = options.runtime || new Runtime({ ...options, dataDir });
  const sessionReader = options.sessionReader || readSession;
  const server = new McpServer({ name: "drive-it", version: "0.1.0" });

  server.registerTool("get_revit_session", {
    description: "Read the Revit version, build, and current-user connection identity from a running Drive It add-in.",
    inputSchema: { processId: processId.describe("Windows process ID of Revit.exe") },
    outputSchema: {
      processId,
      version: z.string(),
      build: z.string(),
      connectionIdentity: z.string(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ processId }) => {
    try {
      const info = await sessionReader(processId);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: sessionError(error) }] };
    }
  });

  server.registerTool("execute_script", {
    description: "Run inline Python or an exact saved script revision in the isolated fixed worker. File and typed Revit effects follow the persistent workspace policy and return a durable receipt.",
    inputSchema: {
      processId: processId.describe("Windows process ID of the selected Revit.exe"),
      source: z.string().min(1).optional().describe("Inline Python source; mutually exclusive with script"),
      script: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).optional().describe("Exact saved script revision; mutually exclusive with source"),
      arguments: z.record(z.string(), z.unknown()).optional().describe("JSON arguments exposed to Python as args"),
      document: document.optional().describe("Optional model path and broker-issued document handle"),
      idempotencyKey: z.string().min(1).max(200).optional().describe("Replay key; completed runs return their original receipt"),
      timeoutMs: z.number().int().positive().max(120000).optional().describe("Worker timeout, default 30000 ms"),
    },
    // Must list every receipt field: MCP clients reject structured content with undeclared properties.
    outputSchema: {
      runId: z.string(),
      idempotencyKey: z.string(),
      fingerprint: z.string(),
      codeHash: z.string(),
      savedScript: z.unknown().nullable(),
      status: receiptStatus,
      session: z.record(z.string(), z.unknown()).nullable(),
      document: z.record(z.string(), z.unknown()).nullable(),
      workspaceRoot: z.string().nullable(),
      arguments: z.record(z.string(), z.unknown()),
      changes: z.array(z.unknown()),
      affectedFiles: z.array(z.unknown()),
      affectedElements: z.array(z.unknown()),
      checks: z.array(z.unknown()),
      policyDecisionIds: z.array(z.string()),
      policyRequests: z.array(z.unknown()),
      result: z.unknown().nullable(),
      logs: z.string(),
      error: z.unknown().nullable(),
      startedAt: z.string(),
      completedAt: z.string().nullable(),
    },
  }, async input => {
    try {
      const receipt = await runtime.execute(input);
      return {
        isError: ["failed", "timed_out", "partially_applied"].includes(receipt.status) || undefined,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `${error.code || "EXECUTION_FAILED"}: ${error.message}` }] };
    }
  });

  server.registerTool("get_api_reference", {
    description: "Return local versioned Drive It Python operation references; no external reference service is used.",
    inputSchema: { name: z.string().optional().describe("Optional exact callable name, such as revit.create_level") },
    outputSchema: {
      version: z.string(),
      entries: z.array(z.object({
        name: z.string(),
        apiVersion: z.string(),
        arguments: z.record(z.string(), z.string()),
        results: z.string(),
        effects: z.string(),
        example: z.string(),
      })),
    },
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    const result = { version: API_VERSION, entries: apiReference(name) };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });

  return { server, runtime };
}
