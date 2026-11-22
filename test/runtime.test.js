import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../server/runtime.js";
import { runWorker } from "../server/worker.js";

async function fixture(t, options = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "drive-it-test-")));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const dataDir = path.join(base, "data");
  await mkdir(root);
  await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = new Runtime({
    dataDir,
    sessionReader: async processId => ({ processId, version: "2026", build: "test", connectionIdentity: "test-session" }),
    ...options,
  });
  await runtime.workspace.setRoot(root);
  return { base, root, outside, dataDir, runtime };
}

function request(root, overrides = {}) {
  return {
    processId: 123,
    source: "result = 1",
    idempotencyKey: "test-run",
    ...overrides,
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test("inline execution, checks, history, and completed replay are durable", async (t) => {
  const { root, runtime } = await fixture(t);
  const target = path.join(root, "result.txt");
  const source = "files.write(args[\"path\"], args[\"text\"])\nresult = files.read(args[\"path\"])\nchecks.record(\"content\", result == \"ok\", result)";
  const first = await runtime.execute(request(root, {
    source,
    arguments: { path: target, text: "ok" },
  }));
  assert.equal(first.status, "succeeded", first.error?.message);
  assert.equal(first.result, "ok");
  assert.equal(first.workspaceRoot, await runtime.workspace.getRoot());
  assert.equal(first.session.version, "2026");
  assert.match(first.codeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.checks, [{ name: "content", passed: true, observed: "ok" }]);
  assert.deepEqual(first.changes, [{ operation: "write_file", paths: [target] }]);
  assert.deepEqual(first.affectedFiles.map(effect => effect.operation), ["write_file", "read_file"]);
  assert.equal(await readFile(target, "utf8"), "ok");
  assert.deepEqual(await runtime.history.get(first.runId), first);

  await rm(target);
  const replay = await runtime.execute(request(root, {
    source,
    arguments: { path: target, text: "ok" },
  }));
  assert.deepEqual(replay, first);
  assert.equal(await exists(target), false);
});

test("saved references resolve exact revisions and ambiguous calls are rejected", async (t) => {
  const { root, runtime } = await fixture(t, {
    scriptResolver: async script => {
      assert.deepEqual(script, { id: "area", revision: 7 });
      return { source: "result = args[\"value\"] * 2" };
    },
  });
  const receipt = await runtime.execute(request(root, {
    source: undefined,
    script: { id: "area", revision: 7 },
    arguments: { value: 4 },
  }));
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.result, 8);
  assert.deepEqual(receipt.savedScript, { id: "area", revision: 7, codeHash: receipt.codeHash });
  await assert.rejects(runtime.execute(request(root, {
    source: "result = 1",
    script: { id: "area", revision: 7 },
  })), error => error.code === "AMBIGUOUS_SCRIPT");
});

test("fixed stdlib imports work without reference services or package changes", async (t) => {
  const { root, runtime } = await fixture(t);
  const receipt = await runtime.execute(request(root, {
    source: "import csv\nimport json\nimport math\nresult = {\"root\": math.sqrt(9), \"dialect\": csv.excel.delimiter}",
  }));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
  assert.deepEqual(receipt.result, { root: 3, dialect: "," });
  assert.deepEqual(receipt.policyDecisionIds, []);
});

test("in-root create, overwrite, rename, move, and delete need no decisions", async (t) => {
  const { root, runtime } = await fixture(t);
  const source = `
files.write(args["a"], "one")
files.write(args["a"], "two")
files.rename(args["a"], args["b"])
files.move(args["b"], args["c"])
result = files.read(args["c"])
files.delete(args["c"])
`;
  const receipt = await runtime.execute(request(root, {
    source,
    arguments: { a: path.join(root, "a.txt"), b: path.join(root, "b.txt"), c: path.join(root, "c.txt") },
  }));
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.result, "two");
  assert.equal(await exists(path.join(root, "c.txt")), false);
  assert.deepEqual(await runtime.decisions.list(), []);
});

test("outside-root denial leaves the target unchanged", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const target = path.join(outside, "denied.txt");
  const source = "files.write(args[\"path\"], \"not allowed\")";
  const pending = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(pending.status, "pending");
  assert.equal(pending.policyRequests[0].paths[0], target);
  assert.equal(await exists(target), false);
  const decision = (await runtime.decisions.list())[0];
  await runtime.decisions.decide(decision.id, false);
  const denied = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(denied.status, "denied");
  assert.equal(denied.runId, pending.runId);
  assert.equal(await exists(target), false);
});

test("an outside-root approval is consumed once and replay does not repeat writes", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const target = path.join(outside, "approved.txt");
  const source = "files.write(args[\"path\"], \"approved\")";
  const pending = await runtime.execute(request(root, { source, arguments: { path: target } }));
  const decision = (await runtime.decisions.list())[0];
  await runtime.decisions.decide(decision.id, true);
  const approved = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(approved.status, "succeeded", approved.error?.message);
  assert.equal(approved.runId, pending.runId);
  assert.deepEqual(approved.policyDecisionIds, [decision.id]);
  assert.equal((await runtime.decisions.get(decision.id)).status, "consumed");
  assert.equal(await readFile(target, "utf8"), "approved");

  await writeFile(target, "changed later");
  const replay = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.deepEqual(replay, approved);
  assert.equal(await readFile(target, "utf8"), "changed later");
});

test("a linked in-root path resolving outside requires a decision", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  const target = path.join(root, "link", "escape.txt");
  const receipt = await runtime.execute(request(root, {
    source: "open(args[\"path\"], \"w\").write(\"no\")",
    arguments: { path: target },
  }));
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.policyRequests[0].paths[0], path.join(outside, "escape.txt"));
  assert.equal(await exists(path.join(outside, "escape.txt")), false);
});

test("deleting the root entry is an outside-root operation", async (t) => {
  const { root, runtime } = await fixture(t);
  const receipt = await runtime.execute(request(root, {
    source: "files.delete(args[\"path\"])",
    arguments: { path: root },
  }));
  assert.equal(receipt.status, "pending");
  assert.equal(await exists(root), true);
});

test("typed Revit calls preserve the broker envelope and observed effects", async (t) => {
  const envelopes = [];
  const { root, runtime } = await fixture(t, {
    brokerExecutor: async (processId, envelope) => {
      envelopes.push({ processId, envelope });
      return {
        id: envelope.id,
        status: "succeeded",
        document: { path: null, uniqueId: "doc-handle", kind: "rvt" },
        changes: [{ type: "create_level" }],
        affectedFiles: [],
        affectedElements: [{ elementId: 42 }],
        checks: [{ name: "committed", passed: true }],
      };
    },
  });
  const receipt = await runtime.execute(request(root, {
    source: "result = revit.create_level(name=\"L2\", elevation=4.0)",
  }));
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.document.uniqueId, "doc-handle");
  assert.deepEqual(receipt.affectedElements, [{ elementId: 42 }]);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].processId, 123);
  assert.equal(envelopes[0].envelope.type, "model.execute");
  assert.equal(envelopes[0].envelope.workspaceRoot, await runtime.workspace.getRoot());
  assert.deepEqual(envelopes[0].envelope.operations, [{ type: "create_level", arguments: { name: "L2", elevation: 4 } }]);
  assert.equal(envelopes[0].envelope.outsideRootApproval, undefined);
});

test("broker policy preflight attaches only a Node-generated one-time grant", async (t) => {
  const calls = [];
  const { root, outside, runtime: runtimeWithBroker } = await fixture(t, {
    brokerExecutor: async (processId, envelope) => {
      calls.push(envelope);
      if (!envelope.outsideRootApproval) {
        return { id: envelope.id, status: "policy_required", policyRequests: [{ operation: "save_as_document", paths: [target] }] };
      }
      return { id: envelope.id, status: "succeeded", changes: ["saved"], affectedFiles: [target], affectedElements: [], checks: [] };
    },
  });
  const target = path.join(outside, "model.rvt");
  const source = "result = revit.save_as_document(path=args[\"path\"])";
  const pending = await runtimeWithBroker.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(pending.status, "pending");
  const decision = (await runtimeWithBroker.decisions.list())[0];
  await runtimeWithBroker.decisions.decide(decision.id, true);
  const approved = await runtimeWithBroker.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(approved.status, "succeeded", approved.error?.message);
  const retry = calls.at(-1);
  assert.equal(retry.outsideRootApproval.decisionId, decision.id);
  assert.deepEqual(retry.outsideRootApproval.grants, [{ operation: "save_as_document", paths: [target] }]);
  assert.equal(retry.operations[0].arguments.outsideRootApproval, undefined);
});

test("failed and partial broker outcomes remain distinct and retain effects", async (t) => {
  for (const [status, expected] of [["failed", "failed"], ["partially_applied", "partially_applied"]]) {
    const { root, runtime } = await fixture(t, {
      brokerExecutor: async (processId, envelope) => ({
        id: envelope.id,
        status,
        changes: status === "failed" ? [] : ["file saved"],
        affectedFiles: status === "failed" ? [] : ["model.rvt"],
        affectedElements: [],
        checks: [],
        error: { code: "BROKER_TEST", message: status },
      }),
    });
    const receipt = await runtime.execute(request(root, { source: "revit.read_document()" }));
    assert.equal(receipt.status, expected);
    assert.equal(receipt.error.code, "BROKER_TEST");
    assert.deepEqual(receipt.affectedFiles, status === "failed" ? [] : ["model.rvt"]);
  }
});

test("a later local failure reports partial effects instead of claiming rollback", async (t) => {
  const { root, runtime } = await fixture(t);
  const target = path.join(root, "completed.txt");
  const receipt = await runtime.execute(request(root, {
    source: "files.write(args[\"path\"], \"completed\")\nfiles.read(args[\"missing\"])",
    arguments: { path: target, missing: path.join(root, "missing.txt") },
  }));
  assert.equal(receipt.status, "partially_applied");
  assert.deepEqual(receipt.changes, [{ operation: "write_file", paths: [target] }]);
  assert.equal(await readFile(target, "utf8"), "completed");
});

test("package installation and process execution fail inside the fixed worker", async (t) => {
  for (const source of ["import ensurepip", "import subprocess", "os.system(\"echo no\")"]) {
    const { root, runtime } = await fixture(t);
    const receipt = await runtime.execute(request(root, { source: source === "os.system(\"echo no\")" ? `import os\n${source}` : source }));
    assert.equal(receipt.status, "failed", JSON.stringify(receipt));
    assert.ok(receipt.error, JSON.stringify(receipt));
    assert.match(`${receipt.error.message}${receipt.error.traceback || ""}`, /disabled/);
  }
});

test("timeout stops the worker, retains observed effects, and removes temporary files", async (t) => {
  let temporary;
  const { root, runtime } = await fixture(t, {
    workerRunner: options => {
      temporary = options.cwd;
      return runWorker(options);
    },
  });
  const target = path.join(root, "before-timeout.txt");
  const receipt = await runtime.execute(request(root, {
    source: "files.write(args[\"path\"], \"completed\")\nwhile True: pass",
    arguments: { path: target },
    timeoutMs: 300,
  }));
  assert.equal(receipt.status, "timed_out");
  assert.equal(receipt.error.code, "RUN_TIMEOUT");
  assert.deepEqual(receipt.changes, [{ operation: "write_file", paths: [target] }]);
  assert.equal(await readFile(target, "utf8"), "completed");
  assert.equal(await exists(temporary), false);
});

test("history survives a persistent root change and idempotency conflicts are rejected", async (t) => {
  const { base, root, runtime } = await fixture(t);
  const first = await runtime.execute(request(root, { source: "result = 5" }));
  const secondRoot = path.join(base, "second-root");
  await mkdir(secondRoot);
  await runtime.workspace.setRoot(secondRoot);
  assert.equal(await runtime.workspace.getRoot(), secondRoot);
  assert.deepEqual(await runtime.history.get(first.runId), first);
  assert.equal(first.workspaceRoot, root);
  await assert.rejects(runtime.execute(request(root, { source: "result = 6" })), error => error.code === "IDEMPOTENCY_CONFLICT");
});
