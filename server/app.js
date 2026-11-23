import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiReference, API_VERSION } from "./reference.js";
import { Runtime } from "./runtime.js";
import { revitContent } from "./content.js";
import { executeBroker, readSession, resolveProcessId, sessionError } from "./session.js";
import { launchRootFrom, PIXEL_SIZE, ReferenceImages, retentionFrom } from "./capture.js";
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

// The every-turn visual QA rule, carried by both the server instructions and the tool description.
const VISUAL_QA_RULE = "After each modeling round and before reporting it complete: (1) review the run receipts and run explicit checks for the requested outcome; (2) if the round created or changed visible geometry, view graphics, or presentation, call capture_revit_view on at least one relevant existing view, and on more views when one projection cannot show the shape, placement, or clearance; (3) look at the returned image against the request and the checks, fix a visible discrepancy that is within the request, then repeat the checks and the capture; (4) report what was checked and what remains unverified. If a capture fails or no useful view exists, say that visual evidence is missing; never claim a visual pass you did not see. A round with only non-visual changes may rely on structured checks and say why a capture adds nothing. An image supports the receipts and checks; it does not prove hidden geometry, parameter values, or model quality.";

export const SERVER_INSTRUCTIONS = `Drive It drives a live Autodesk Revit 2026 session. Call get_revit_session first, model with execute_script, and keep its receipts and checks as the authoritative record. Visual self-QA every modeling turn: ${VISUAL_QA_RULE}`;

const CAPTURE_DESCRIPTION = `Export an existing Revit view to a PNG with Revit's own renderer (Document.ExportImage, not a screenshot) and return the image for you to inspect. Supported: 3D, floor plan, ceiling plan, structural plan, elevation, section, and detail views in RVT and RFA documents; sheets, schedules, legends, drafting views, and view templates are rejected. It does not modify the Revit model; it writes a local reference image (PNG plus JSON metadata) under the server's launch root in _reference-images/<session>, deleted at session end unless retain is true or the operator keeps all captures. The view is exported as it is set up (orientation, crop, visibility); change a view through execute_script first if needed. Omit viewId to capture the document's active view; errors list capturable views with their ids. ${VISUAL_QA_RULE}`;

export function createDriveItServer(options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  const runtime = options.runtime || new Runtime({ ...options, dataDir });
  const sessionReader = options.sessionReader || readSession;
  const processResolver = options.processResolver || resolveProcessId;
  const contentReader = options.contentReader || revitContent;
  const server = new McpServer({ name: "drive-it", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  // Captured once at startup: later changes to the working directory or the modeling workspace
  // never move reference images.
  const references = options.references || new ReferenceImages({
    launchRoot: options.launchRoot ?? launchRootFrom(),
    retention: options.referenceRetention ?? retentionFrom(process.env.DRIVE_IT_REFERENCE_RETENTION),
    brokerExecutor: options.brokerExecutor || executeBroker,
    sessionReader,
  });

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

  const captureMetadata = {
    schema: z.string(),
    captureId: z.string(),
    sessionId: z.string(),
    createdAt: z.string(),
    purpose: z.string(),
    relatedRunIds: stringList,
    retention: z.object({
      mode: z.enum(["session", "keep"]),
      requested: z.boolean(),
      retained: z.boolean(),
      survivesSessionEnd: z.boolean(),
    }),
    image: z.object({
      path: z.string().describe("Launch-root-relative path of the saved PNG"),
      mimeType: z.literal("image/png"),
      sha256: z.string(),
      byteSize: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
    }),
    revit: z.object({ processId, version: z.string(), build: z.string() }),
    document: z.object({
      uniqueId: z.string().nullable(),
      title: z.string().nullable(),
      path: z.string().nullable(),
      kind: z.string().nullable(),
    }),
    view: z.object({
      id: z.string().nullable(),
      uniqueId: z.string().nullable(),
      name: z.string().nullable(),
      type: z.string().nullable(),
    }),
    export: z.object({
      mechanism: z.literal("Document.ExportImage"),
      requestedPixelSize: z.number().int(),
      fitDirection: z.string().nullable(),
      temporaryViewCreated: z.boolean(),
      transactionStarted: z.boolean(),
      documentModifiedBefore: z.boolean().nullable(),
      documentModifiedAfter: z.boolean().nullable(),
    }),
  };

  server.registerTool("capture_revit_view", {
    title: "Capture Revit view",
    description: CAPTURE_DESCRIPTION,
    inputSchema: {
      processId: processId.optional().describe("Windows process ID of the selected Revit.exe; omit it to use the only running Revit"),
      document: document.optional().describe("Optional {path, uniqueId} of an open document, as in execute_script receipts; omit to use the document shown in Revit's window"),
      viewId: z.union([
        z.string().regex(/^[1-9][0-9]{0,18}$/),
        z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      ]).optional().describe("Exact Revit view element id, preferably as a decimal string such as \"312\"; omit to capture the document's active view"),
      pixelSize: z.number().int().min(PIXEL_SIZE.min).max(PIXEL_SIZE.max).optional()
        .describe(`Longer image side in pixels, ${PIXEL_SIZE.min}-${PIXEL_SIZE.max}, default ${PIXEL_SIZE.default}`),
      purpose: z.string().trim().min(1).max(500).describe("Required. The modeling question this capture is meant to verify, e.g. \"Are the four walls closed at the corners?\""),
      relatedRunIds: z.array(z.string().min(1).max(200)).max(50).optional().describe("execute_script runIds this capture verifies"),
      retain: z.boolean().optional().describe("Keep this image after the session ends so the user can review it"),
    },
    outputSchema: {
      ...captureMetadata,
      absolutePath: z.string().describe("Where the user can open the PNG"),
      sidecarPath: z.string().describe("Launch-root-relative path of the JSON metadata"),
    },
    annotations: {
      title: "Capture Revit view",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async input => {
    try {
      const resolved = await processResolver(input.processId);
      const { metadata, bytes, absolutePath } = await references.capture({
        ...input,
        processId: resolved,
        viewId: input.viewId === undefined ? undefined : String(input.viewId),
      });
      const value = {
        ...metadata,
        absolutePath,
        sidecarPath: metadata.image.path.replace(/\.png$/, ".json"),
      };
      const survives = metadata.retention.survivesSessionEnd
        ? "It is kept after this session ends."
        : "It is deleted when this session ends; pass retain: true to keep a capture for the user.";
      const summary = `Captured ${metadata.view.type} view "${metadata.view.name}" (id ${metadata.view.id}) of "${metadata.document.title}" at ${metadata.image.width}x${metadata.image.height}. Inspect the image against the request and the checks before reporting. Saved for the user at ${absolutePath}. ${survives}`;
      return {
        content: [
          { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
          { type: "text", text: `${summary}\n${JSON.stringify(value)}` },
        ],
        structuredContent: value,
      };
    } catch (error) {
      // Drive It codes pass through; socket errors (ENOENT, EPIPE, ...) become a Revit hint.
      const ours = typeof error.code === "string" && error.code.includes("_") && !error.code.startsWith("ERR_");
      const failure = ours ? error : Object.assign(new Error(sessionError(error)), { code: "REVIT_UNAVAILABLE" });
      failure.message = `${failure.message} No image was captured; report the missing visual evidence rather than a visual pass.`;
      return toolError(failure);
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

  return { server, runtime, references };
}
