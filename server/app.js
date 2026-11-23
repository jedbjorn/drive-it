import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiReference, API_VERSION } from "./reference.js";
import { Runtime } from "./runtime.js";
import { revitContent } from "./content.js";
import { readSession, resolveProcessId, sessionError } from "./session.js";
import { defaultDataDir } from "./store.js";
import { SCRIPT_ID, summarize as summarizeRow } from "./library.js";

function toolResult(value, isError) {
  return { isError: isError || undefined, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(error) {
  const detail = error.detail === undefined ? "" : ` ${JSON.stringify(error.detail)}`;
  return { isError: true, content: [{ type: "text", text: `${error.code || "SCRIPT_LIBRARY_FAILED"}: ${error.message}${detail}` }] };
}

async function attempt(task) {
  try {
    return await task();
  } catch (error) {
    return toolError(error);
  }
}

const processId = z.number().int().positive().max(0xffffffff);
const document = z.object({
  path: z.string().min(1).nullable().optional(),
  uniqueId: z.string().min(1).nullable().optional(),
  kind: z.enum(["rvt", "rfa", "unknown"]).optional(),
});
const scriptId = z.string().regex(SCRIPT_ID).describe("Stable script identifier");
const scriptReference = z.object({
  scriptId,
  revision: z.union([z.number().int().positive(), z.literal("latest")]),
}).strict();
const documentKind = z.enum(["rvt", "rfa"]);
const stringList = z.array(z.string());
const scriptSummary = z.object({
  scriptId: z.string(),
  revision: z.number().int(),
  name: z.string(),
  purpose: z.string(),
  domain: z.string(),
  documentKind,
  state: z.enum(["draft", "active", "retired"]),
  codeHash: z.string(),
  createdAt: z.string(),
  promotedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});
const receiptStatus = z.enum(["pending", "denied", "failed", "timed_out", "partially_applied", "succeeded"]);

// Plain instructions ahead of the JSON receipt, so a model resumes a pending run instead of
// starting a new request with a new key.
function statusGuidance(receipt) {
  if (receipt.status === "pending") {
    return `WAITING FOR THE USER: this run needs a one-time approval for ${receipt.policyRequests.map(request => `${request.operation} ${request.paths.join(", ")}`).join("; ")}. Ask the user to approve or deny it in the Drive-It window (Revit Add-Ins tab > Drive-It, or Start menu > Drive-It). After they approve, call execute_script again with idempotencyKey "${receipt.idempotencyKey}" and the same request to resume; a different key starts a new request that needs a new approval.\n`;
  }
  if (receipt.status === "denied") {
    return "DENIED BY THE USER: do not retry this request; ask the user how they want to proceed.\n";
  }
  return "";
}

export function createDriveItServer(options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  const runtime = options.runtime || new Runtime({ ...options, dataDir });
  const sessionReader = options.sessionReader || readSession;
  const processResolver = options.processResolver || resolveProcessId;
  const contentReader = options.contentReader || revitContent;
  const server = new McpServer({ name: "drive-it", version: "0.1.0" });

  server.registerTool("get_revit_session", {
    description: "Call this first. Finds the running Revit (processId is optional when only one Revit has Drive It loaded) and returns its version, the workspace root where Drive It saves and reads files without asking the user (null until the user picks one in the Drive-It window; ask them to), and Revit's installed project templates, family template folders, and library folders. Use these real paths instead of guessing file names.",
    inputSchema: { processId: processId.optional().describe("Windows process ID of Revit.exe; omit it to use the only running Revit") },
    outputSchema: {
      processId,
      version: z.string(),
      build: z.string(),
      connectionIdentity: z.string(),
      workspaceRoot: z.string().nullable(),
      content: z.object({
        projectTemplates: stringList,
        familyTemplateFolders: stringList,
        libraryFolders: stringList,
      }),
    },
    annotations: { readOnlyHint: true },
  }, async ({ processId }) => {
    try {
      const info = await sessionReader(await processResolver(processId));
      const workspaceRoot = await runtime.workspace.getRoot().catch(error => {
        if (error.code === "WORKSPACE_NOT_SELECTED") return null;
        throw error;
      });
      const value = { ...info, workspaceRoot, content: await contentReader(info.version) };
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: sessionError(error) }] };
    }
  });

  server.registerTool("execute_script", {
    description: "Run inline Python or an exact saved script revision in the isolated fixed worker. File and typed Revit effects follow the persistent workspace policy and return a durable receipt.",
    inputSchema: {
      processId: processId.optional().describe("Windows process ID of the selected Revit.exe; omit it to use the only running Revit"),
      displayName: z.string().trim().min(1).max(200).describe("Required. One plain-language line, written for the user, saying what this run does to their files or model, e.g. \"Add Level 3 at 24 ft to the tower model\". Shown in the Drive-It operator window's run history and approval requests"),
      source: z.string().min(1).optional().describe("Inline Python source; mutually exclusive with script"),
      script: scriptReference.optional().describe("Saved script reference; mutually exclusive with source. An exact draft or active revision, or \"latest\" for the newest active revision. Retired revisions are rejected"),
      arguments: z.record(z.string(), z.unknown()).optional().describe("JSON arguments exposed to Python as args; saved scripts validate them against the revision's inputSchema and apply its defaults"),
      document: document.optional().describe("Optional model path and broker-issued document handle"),
      idempotencyKey: z.string().min(1).max(200).optional().describe("Replay key; completed runs return their original receipt. To resume a run that returned status pending, call again with the same idempotencyKey and the same request; a new key starts a new request that needs a new approval"),
      timeoutMs: z.number().int().positive().max(120000).optional().describe("Worker timeout, default 30000 ms"),
    },
    // Must list every receipt field: MCP clients reject structured content with undeclared properties.
    outputSchema: {
      runId: z.string(),
      displayName: z.string().nullable(),
      idempotencyKey: z.string(),
      fingerprint: z.string(),
      codeHash: z.string(),
      savedScript: z.object({
        scriptId: z.string(),
        revision: z.number().int(),
        codeHash: z.string(),
        state: z.string(),
        requested: z.union([z.number().int(), z.literal("latest")]),
      }).nullable(),
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
      const receipt = await runtime.execute({ ...input, processId: await processResolver(input.processId) });
      return {
        isError: ["failed", "timed_out", "partially_applied"].includes(receipt.status) || undefined,
        content: [{ type: "text", text: `${statusGuidance(receipt)}${JSON.stringify(receipt)}` }],
        structuredContent: receipt,
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `${error.code || "EXECUTION_FAILED"}: ${error.message}` }] };
    }
  });

  const scripts = runtime.scripts;
  const metadata = {
    name: z.string().min(1).max(200).optional().describe("Display name; required for a new script"),
    purpose: z.string().max(500).optional().describe("One-line purpose"),
    domain: z.string().max(100).optional().describe("Modeling domain, such as levels, walls, or families"),
    documentKind: documentKind.optional().describe("Document kind the script targets; required for a new script"),
    inputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema (type object) for arguments, with defaults; required for a new script"),
    outputs: z.string().max(2000).optional().describe("What result and checks the script reports"),
    expectedEffects: stringList.optional().describe("Expected model or file effects"),
    capabilities: stringList.optional().describe("Required fixed-runtime capabilities, such as revit.create_level or files.write"),
    assumptions: z.string().max(2000).optional().describe("Context needed to judge applicability"),
  };
  const revisionDetail = {
    ...scriptSummary.shape,
    outputs: z.string(),
    expectedEffects: stringList,
    capabilities: stringList,
    assumptions: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    source: z.string(),
    sourceRunIds: stringList,
    workspaceRoot: z.string(),
    promotionRunId: z.string().nullable(),
    promotionEvidence: z.record(z.string(), z.unknown()).nullable(),
    retirementReason: z.string().nullable(),
  };

  server.registerTool("save_script", {
    description: "Save a new draft script, or a new immutable draft revision of an existing script, in the current workspace library. Omitted metadata on a new revision is carried from the previous revision. Never promotes.",
    inputSchema: {
      scriptId: scriptId.optional().describe("Existing script to revise; omit to create a new script"),
      source: z.string().min(1).describe("Python source run by execute_script with args, files, revit, and checks"),
      ...metadata,
      sourceRunIds: stringList.optional().describe("Completed runs that executed exactly this source, kept as provenance"),
      idempotencyKey: z.string().min(1).max(200).optional().describe("Retrying the same key returns the existing revision"),
    },
    outputSchema: { created: z.boolean(), script: scriptSummary },
  }, input => attempt(async () => {
    const { created, revision } = await scripts.save(input);
    return toolResult({ created, script: summarizeRow(revision) });
  }));

  server.registerTool("search_scripts", {
    description: "Search the current workspace script library by name, purpose, domain, and document kind. Returns active revisions unless drafts or retired history are explicitly included.",
    inputSchema: {
      query: z.string().optional().describe("Space-separated terms matched against id, name, purpose, domain, and kind"),
      domain: z.string().optional(),
      documentKind: documentKind.optional(),
      includeDrafts: z.boolean().optional(),
      includeRetired: z.boolean().optional(),
    },
    outputSchema: { workspaceRoot: z.string(), scripts: z.array(scriptSummary) },
    annotations: { readOnlyHint: true },
  }, input => attempt(async () => toolResult(await scripts.search(input))));

  server.registerTool("get_script", {
    description: "Return one script revision's source, metadata, code hash, lifecycle state, provenance, promotion evidence, and linked run receipts.",
    inputSchema: scriptReference.shape,
    outputSchema: {
      ...revisionDetail,
      runs: z.array(z.object({
        runId: z.string(),
        status: receiptStatus,
        checked: z.boolean(),
        checks: z.array(z.unknown()),
        arguments: z.record(z.string(), z.unknown()),
        document: z.record(z.string(), z.unknown()).nullable(),
        revitVersion: z.string().nullable(),
        affectedFiles: z.array(z.unknown()),
        affectedElements: z.array(z.unknown()),
        error: z.unknown().nullable(),
        startedAt: z.string(),
        completedAt: z.string().nullable(),
      })),
    },
    annotations: { readOnlyHint: true },
  }, input => attempt(async () => toolResult(await scripts.get(input))));

  server.registerTool("promote_script", {
    description: "Promote an exact draft revision to active using a checked successful run of that exact revision in this workspace: status succeeded, at least one check, every check passed, matching code hash and document kind. No approval is required. Rejections leave the draft unchanged and list unmet conditions.",
    inputSchema: {
      scriptId,
      revision: z.number().int().positive(),
      runId: z.string().min(1).describe("Run receipt offered as promotion evidence"),
    },
    outputSchema: {
      status: z.enum(["promoted", "rejected"]),
      script: scriptSummary,
      unmet: z.array(z.object({ condition: z.string(), expected: z.unknown(), observed: z.unknown() })),
    },
  }, input => attempt(async () => {
    const result = await scripts.promote(input);
    return toolResult(result, result.status === "rejected");
  }));

  server.registerTool("retire_script", {
    description: "Soft-retire an exact draft or active revision. Source, metadata, and receipts are kept; the revision leaves default search and latest, and rejects new execution. No approval is required.",
    inputSchema: {
      scriptId,
      revision: z.number().int().positive(),
      reason: z.string().max(500).optional(),
    },
    outputSchema: { status: z.literal("retired"), script: scriptSummary },
  }, input => attempt(async () => toolResult(await scripts.retire(input))));

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
