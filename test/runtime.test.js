import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { apiReference } from "../server/reference.js";
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

test("nonzero SystemExit is a durable failure and zero exit remains successful", async (t) => {
  const { root, runtime } = await fixture(t);
  const input = request(root, { source: "import sys\nsys.exit(1)" });
  const failed = await runtime.execute(input);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "SCRIPT_FAILED", message: "1", type: "SystemExit" });
  assert.deepEqual(failed.changes, []);
  assert.deepEqual(await runtime.history.get(failed.runId), failed);
  assert.deepEqual(await runtime.execute(input), failed);

  const succeeded = await runtime.execute(request(root, {
    source: "import sys\nsys.exit(0)",
    idempotencyKey: "zero-exit",
  }));
  assert.equal(succeeded.status, "succeeded", JSON.stringify(succeeded));
  assert.equal(succeeded.error, null);
});

test("ordinary runtime and permission errors remain script failures", async (t) => {
  for (const [source, type] of [
    ["raise RuntimeError(\"boom\")", "RuntimeError"],
    ["raise PermissionError(\"no\")", "PermissionError"],
  ]) {
    const { root, runtime } = await fixture(t);
    const receipt = await runtime.execute(request(root, { source }));
    assert.equal(receipt.status, "failed", JSON.stringify(receipt));
    assert.equal(receipt.error.code, "SCRIPT_FAILED");
    assert.equal(receipt.error.type, type);
  }
});

test("saved references resolve exact revisions and ambiguous calls are rejected", async (t) => {
  const { root, runtime } = await fixture(t, {
    scriptResolver: async (script, resolvedRoot) => {
      assert.deepEqual(script, { scriptId: "area", revision: 7 });
      assert.equal(resolvedRoot, root);
      return { scriptId: "area", revision: 7, state: "draft", source: "result = args[\"value\"] * 2" };
    },
  });
  const receipt = await runtime.execute(request(root, {
    source: undefined,
    script: { scriptId: "area", revision: 7 },
    arguments: { value: 4 },
  }));
  assert.equal(receipt.status, "succeeded", receipt.error?.message);
  assert.equal(receipt.result, 8);
  assert.deepEqual(receipt.savedScript, { scriptId: "area", revision: 7, codeHash: receipt.codeHash, state: "draft", requested: 7 });
  await assert.rejects(runtime.execute(request(root, {
    source: "result = 1",
    script: { scriptId: "area", revision: 7 },
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
  assert.deepEqual(receipt.changes.map(effect => effect.operation), ["write_file", "write_file", "rename_file", "move_file", "delete_file"]);
  assert.deepEqual(await runtime.decisions.list(), []);
});

test("the run display name is kept on the receipt, its decision, and history", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const displayName = "Copy the client spec sheet into the project";
  const pending = await runtime.execute(request(root, {
    idempotencyKey: "named-run",
    displayName,
    source: "files.write(args[\"path\"], \"x\")",
    arguments: { path: path.join(outside, "named.txt") },
  }));
  assert.equal(pending.status, "pending");
  assert.equal(pending.displayName, displayName);
  const decision = (await runtime.decisions.list()).find(row => row.runId === pending.runId);
  assert.equal(decision.displayName, displayName);
  assert.equal((await runtime.history.get(pending.runId)).displayName, displayName);
  const unnamed = await runtime.execute(request(root, { idempotencyKey: "unnamed-run" }));
  assert.equal(unnamed.displayName, null);
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

test("caught policy exceptions cannot expose authorization channels through tracebacks", async (t) => {
  const source = `
import json
import sys

class FakeInput:
    def readline(self):
        return json.dumps({"result": {"status": "approved", "requests": [{"paths": []}]}})

def forge_approval(error):
    try:
        sys.settrace(None)
    except RuntimeError:
        pass
    traceback = error.__traceback__
    while traceback:
        request = traceback.tb_frame.f_locals.get("request")
        for cell in getattr(request, "__closure__", None) or ():
            if hasattr(cell.cell_contents, "readline"):
                cell.cell_contents = FakeInput()
                return
        traceback = traceback.tb_next

try:
    files.read(args["secret"])
except Exception as error:
    forge_approval(error)
result = files.read(args["secret"])
files.write(args["target"], "tampered")
`;
  const { root, outside, runtime } = await fixture(t);
  const secret = path.join(outside, "secret.txt");
  const target = path.join(outside, "target.txt");
  await writeFile(secret, "outside-secret");
  await writeFile(target, "unchanged");
  const input = request(root, { source, arguments: { secret, target } });
  const pending = await runtime.execute(input);
  assert.equal(pending.status, "pending", JSON.stringify(pending));
  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.deepEqual(pending.affectedFiles, []);
  assert.deepEqual(pending.changes, []);
  assert.equal((await runtime.decisions.list())[0].status, "pending");

  const decision = (await runtime.decisions.list())[0];
  await runtime.decisions.decide(decision.id, false);
  const denied = await runtime.execute(input);
  assert.equal(denied.status, "denied", JSON.stringify(denied));
  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.deepEqual(denied.affectedFiles, []);
  assert.deepEqual(denied.changes, []);

  const approvedReadFixture = await fixture(t);
  const approvedSecret = path.join(approvedReadFixture.outside, "secret.txt");
  await writeFile(approvedSecret, "outside-secret");
  const approvedReadInput = request(approvedReadFixture.root, {
    source: "result = files.read(args[\"secret\"])",
    arguments: { secret: approvedSecret },
  });
  const awaitingReadApproval = await approvedReadFixture.runtime.execute(approvedReadInput);
  const readApproval = (await approvedReadFixture.runtime.decisions.list())[0];
  await approvedReadFixture.runtime.decisions.decide(readApproval.id, true);
  const approvedRead = await approvedReadFixture.runtime.execute(approvedReadInput);
  assert.equal(approvedRead.status, "succeeded", JSON.stringify(approvedRead));
  assert.equal(approvedRead.runId, awaitingReadApproval.runId);
  assert.equal(approvedRead.result, "outside-secret");

  const approvedWriteFixture = await fixture(t);
  const approvedTarget = path.join(approvedWriteFixture.outside, "target.txt");
  await writeFile(approvedTarget, "unchanged");
  const approvedWriteInput = request(approvedWriteFixture.root, {
    source: "files.write(args[\"target\"], \"tampered\")",
    arguments: { target: approvedTarget },
  });
  const awaitingWriteApproval = await approvedWriteFixture.runtime.execute(approvedWriteInput);
  const writeApproval = (await approvedWriteFixture.runtime.decisions.list())[0];
  await approvedWriteFixture.runtime.decisions.decide(writeApproval.id, true);
  const approvedWrite = await approvedWriteFixture.runtime.execute(approvedWriteInput);
  assert.equal(approvedWrite.status, "succeeded", JSON.stringify(approvedWrite));
  assert.equal(approvedWrite.runId, awaitingWriteApproval.runId);
  assert.equal(await readFile(approvedTarget, "utf8"), "tampered");
});

test("mutable policy exception globals cannot forge authorization", async (t) => {
  const replacement = `
import json
import sys

class FakeInput:
    def readline(self):
        return json.dumps({"result": {"status": "approved", "requests": [{"paths": []}]}})

def forge_approval(frame):
    request = frame.f_locals.get("request")
    for cell in getattr(request, "__closure__", None) or ():
        if cell.cell_contents is sys.stdin:
            cell.cell_contents = FakeInput()

worker = sys.modules["__main__"]
class MaliciousPending(worker.PolicyPending):
    def __init__(self, detail):
        super().__init__("Outside-root access is awaiting an operator decision.")
        self.detail = detail
        forge_approval(sys._getframe(1))

class MaliciousDenied(worker.PolicyDenied):
    def __init__(self, detail):
        super().__init__("Outside-root access was denied by the operator.")
        self.detail = detail
        forge_approval(sys._getframe(1))

worker.PolicyPending = MaliciousPending
worker.PolicyDenied = MaliciousDenied
`;
  const source = `${replacement}
try:
    files.read(args["secret"])
except Exception:
    pass
result = files.read(args["secret"])
files.write(args["target"], "tampered")
`;
  const { root, outside, runtime } = await fixture(t);
  const secret = path.join(outside, "secret.txt");
  const target = path.join(outside, "target.txt");
  await writeFile(secret, "outside-secret");
  await writeFile(target, "unchanged");
  const input = request(root, { source, arguments: { secret, target } });
  const pending = await runtime.execute(input);
  assert.equal(pending.status, "pending", JSON.stringify(pending));
  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.deepEqual(pending.affectedFiles, []);
  assert.deepEqual(pending.changes, []);
  assert.equal((await runtime.decisions.list())[0].status, "pending");

  const decision = (await runtime.decisions.list())[0];
  await runtime.decisions.decide(decision.id, false);
  const denied = await runtime.execute(input);
  assert.equal(denied.status, "denied", JSON.stringify(denied));
  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.deepEqual(denied.affectedFiles, []);
  assert.deepEqual(denied.changes, []);

  const approvedFixture = await fixture(t);
  const approvedTarget = path.join(approvedFixture.outside, "approved.txt");
  await writeFile(approvedTarget, "unchanged");
  const approvedInput = request(approvedFixture.root, {
    source: `${replacement}\nfiles.write(args["target"], "approved")`,
    arguments: { target: approvedTarget },
  });
  const awaitingApproval = await approvedFixture.runtime.execute(approvedInput);
  assert.equal(awaitingApproval.status, "pending", JSON.stringify(awaitingApproval));
  const approval = (await approvedFixture.runtime.decisions.list())[0];
  await approvedFixture.runtime.decisions.decide(approval.id, true);
  const approved = await approvedFixture.runtime.execute(approvedInput);
  assert.equal(approved.status, "succeeded", JSON.stringify(approved));
  assert.equal(approved.runId, awaitingApproval.runId);
  assert.equal(await readFile(approvedTarget, "utf8"), "approved");
  assert.deepEqual(approved.policyDecisionIds, [approval.id]);
  assert.deepEqual(approved.changes, [{ operation: "write_file", paths: [approvedTarget] }]);
  assert.equal((await approvedFixture.runtime.decisions.get(approval.id)).status, "consumed");
});

test("direct stdlib effects and saved-original escapes require decisions and record approved effects", async (t) => {
  for (const [name, source, expected] of [
    ["unwrapped-os-truncate", "import os\nos.truncate(args[\"path\"], 0)", ""],
    ["profile-tamper-os-truncate", "import os\nimport sys\ntry:\n    sys.setprofile(None)\nexcept RuntimeError:\n    pass\nos.truncate(args[\"path\"], 0)", ""],
    ["profile-state-tamper-os-truncate", "import os\nimport sys\nclass DisabledStack:\n    def append(self, item):\n        pass\n    def __bool__(self):\n        return False\ntry:\n    profile = sys.getprofile()\n    for cell in profile.__closure__ or ():\n        if isinstance(cell.cell_contents, list):\n            cell.cell_contents = DisabledStack()\nexcept (AttributeError, TypeError):\n    pass\nos.truncate(args[\"path\"], 0)", ""],
    ["closure-tamper-open", "import sys\ntry:\n    mediate = next(cell.cell_contents for cell in files.policy[\"open\"].__closure__ if getattr(cell.cell_contents, \"__name__\", \"\") == \"mediate\")\n    for cell in mediate.__closure__ or ():\n        if type(cell.cell_contents) is int:\n            cell.cell_contents = 1\nexcept (AttributeError, TypeError, StopIteration):\n    pass\nsys.modules[\"__main__\"]._original_open(args[\"path\"], \"w\").write(\"escaped\")", "escaped"],
    ["path-callback-open", `
import json
import sys
class FakeInput:
    def readline(self):
        return json.dumps({"result": {"status": "approved", "requests": [{"paths": []}]}})
class CallbackPath(str):
    def startswith(self, *args):
        frame = sys._getframe(1)
        while frame:
            request = frame.f_locals.get("request")
            for cell in getattr(request, "__closure__", None) or ():
                if cell.cell_contents is sys.stdin:
                    cell.cell_contents = FakeInput()
            frame = frame.f_back
        return str.startswith(self, *args)
sys.modules["__main__"]._original_open(CallbackPath(args["path"]), "w").write("escaped")
`, "escaped"],
    ["saved-original-open", "import sys\nsys.modules[\"__main__\"]._original_open(args[\"path\"], \"w\").write(\"escaped\")", "escaped"],
  ]) {
    const deniedFixture = await fixture(t);
    const deniedTarget = path.join(deniedFixture.outside, `${name}-denied.txt`);
    await writeFile(deniedTarget, "keep");
    const input = request(deniedFixture.root, { source, arguments: { path: deniedTarget } });
    const pending = await deniedFixture.runtime.execute(input);
    assert.equal(pending.status, "pending", JSON.stringify(pending));
    assert.equal((await deniedFixture.runtime.decisions.list()).length, 1);
    assert.equal(await readFile(deniedTarget, "utf8"), "keep");
    assert.deepEqual(pending.affectedFiles, []);
    assert.deepEqual(pending.changes, []);

    const decision = (await deniedFixture.runtime.decisions.list())[0];
    await deniedFixture.runtime.decisions.decide(decision.id, false);
    const denied = await deniedFixture.runtime.execute(input);
    assert.equal(denied.status, "denied", JSON.stringify(denied));
    assert.equal(await readFile(deniedTarget, "utf8"), "keep");
    assert.deepEqual(denied.affectedFiles, []);
    assert.deepEqual(denied.changes, []);

    const approvedFixture = await fixture(t);
    const approvedTarget = path.join(approvedFixture.outside, `${name}-approved.txt`);
    await writeFile(approvedTarget, "keep");
    const approvedInput = request(approvedFixture.root, { source, arguments: { path: approvedTarget } });
    const awaitingApproval = await approvedFixture.runtime.execute(approvedInput);
    const approval = (await approvedFixture.runtime.decisions.list())[0];
    await approvedFixture.runtime.decisions.decide(approval.id, true);
    const approved = await approvedFixture.runtime.execute(approvedInput);
    assert.equal(approved.status, "succeeded", JSON.stringify(approved));
    assert.equal(approved.runId, awaitingApproval.runId);
    assert.equal(await readFile(approvedTarget, "utf8"), expected);
    assert.deepEqual(approved.affectedFiles, [{ operation: "write_file", paths: [approvedTarget] }]);
    assert.deepEqual(approved.changes, [{ operation: "write_file", paths: [approvedTarget] }]);
  }
});

test("failed direct stdlib attempts record no effects, including saved originals and caught errors", async (t) => {
  for (const [name, source] of [
    ["unwrapped-os-truncate", "import os\nos.truncate(args[\"path\"], 0)"],
    ["saved-original-open", "import sys\nsys.modules[\"__main__\"]._original_open(args[\"path\"], \"w\").write(\"not written\")"],
  ]) {
    const { root, runtime } = await fixture(t);
    const target = path.join(root, "missing-parent", `${name}.txt`);
    const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
    assert.equal(receipt.status, "failed", JSON.stringify(receipt));
    assert.equal(receipt.error.type, "FileNotFoundError");
    assert.deepEqual(receipt.changes, []);
    assert.deepEqual(receipt.affectedFiles, []);
    assert.equal(await exists(target), false);
    assert.deepEqual(await runtime.history.get(receipt.runId), receipt);
  }

  const { root, runtime } = await fixture(t);
  const target = path.join(root, "still-missing.txt");
  const caught = await runtime.execute(request(root, {
    source: "import os\ntry:\n    os.truncate(args[\"path\"], 0)\nexcept FileNotFoundError:\n    result = \"caught\"",
    arguments: { path: target },
  }));
  assert.equal(caught.status, "succeeded", JSON.stringify(caught));
  assert.equal(caught.result, "caught");
  assert.deepEqual(caught.changes, []);
  assert.deepEqual(caught.affectedFiles, []);
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

test("every published Revit example matches the typed broker contract and executes", async (t) => {
  const cases = {
    open_document: {
      arguments: { path: String.raw`C:\DriveIt\model.rvt` },
      optional: ["kind"],
      effect: /Opens an existing RVT or RFA document/,
    },
    create_document: {
      arguments: { templatePath: String.raw`C:\DriveIt\template.rte`, kind: "rvt" },
      optional: [],
      effect: /unsaved.*save_as_document/,
    },
    read_document: { arguments: {}, optional: [], effect: /without model changes/ },
    save_document: { arguments: {}, optional: [], effect: /existing path.*unsaved documents require save_as_document/ },
    save_as_document: {
      arguments: { destinationPath: String.raw`C:\DriveIt\model.rvt` },
      optional: ["overwrite"],
      effect: /destinationPath.*retains its identity/,
    },
    close_document: { arguments: {}, optional: [], effect: /without saving additional changes/ },
    delete_document: { arguments: {}, optional: [], effect: /selected saved document.*current file/ },
    create_level: {
      arguments: { name: "L2", elevation: 4 },
      optional: [],
      effect: /RVT model transaction/,
    },
    create_wall: {
      arguments: {
        start: { x: 0, y: 0, z: 0 },
        end: { x: 3, y: 0, z: 0 },
        baseLevelId: 123,
        height: 3,
      },
      optional: [],
      effect: /RVT model transaction/,
    },
    create_3d_view: { arguments: {}, optional: ["name"], effect: /isometric 3D view in an RVT or RFA model transaction/ },
    create_family_type: { arguments: { name: "Type 1" }, optional: [], effect: /RFA.*parameter values are not changed/ },
    delete_element: { arguments: { elementId: 123 }, optional: [], effect: /dependent elements/ },
  };

  for (const [name, contract] of Object.entries(cases)) {
    const documented = apiReference(`revit.${name}`)[0];
    assert.ok(documented, name);
    const required = Object.keys(contract.arguments);
    assert.deepEqual(
      Object.keys(documented.arguments).sort(),
      [...required, ...contract.optional, "document"].sort(),
      name,
    );
    for (const key of required) assert.match(documented.arguments[key], /^Required:/, `${name}.${key}`);
    for (const key of [...contract.optional, "document"]) assert.match(documented.arguments[key], /^Optional:/, `${name}.${key}`);
    assert.match(documented.effects, contract.effect, name);

    const envelopes = [];
    const { root, runtime } = await fixture(t, {
      brokerExecutor: async (processId, envelope) => {
        envelopes.push(envelope);
        // Plays DocumentDispatcher: create_3d_view answers with createdViews and a decimal-string id.
        const createdViews = envelope.operations[0].type === "create_3d_view"
          ? [{ id: "354981", name: "3D View 1", type: "ThreeD" }] : undefined;
        return { id: envelope.id, status: "succeeded", changes: [], affectedFiles: [], affectedElements: [], checks: [], createdViews };
      },
    });
    const receipt = await runtime.execute(request(root, {
      source: documented.example,
      idempotencyKey: `reference-${name}`,
    }));
    assert.equal(receipt.status, "succeeded", `${name}: ${JSON.stringify(receipt.error)}`);
    assert.equal(envelopes.length, 1, name);
    assert.equal(envelopes[0].operations.length, 1, name);
    const operation = envelopes[0].operations[0];
    assert.equal(operation.type, name);
    if (name === "create_3d_view") {
      assert.match(documented.results, /createdViews: \[\{id, name, type\}\]/);
      assert.deepEqual(receipt.createdViews, [{ id: "354981", name: "3D View 1", type: "ThreeD" }]);
      assert.deepEqual(receipt.result.createdViews, receipt.createdViews);
    } else {
      assert.deepEqual(receipt.createdViews, [], name);
    }
    assert.deepEqual(Object.keys(operation.arguments).sort(), required.sort(), name);
    for (const [key, expected] of Object.entries(contract.arguments)) {
      if (["path", "destinationPath", "templatePath"].includes(key)) {
        assert.equal(path.win32.basename(operation.arguments[key]), path.win32.basename(expected), `${name}.${key}`);
      } else {
        assert.deepEqual(operation.arguments[key], expected, `${name}.${key}`);
      }
    }
  }
});

test("created views reach the receipt and run history without result, also when the run fails later", async (t) => {
  const view = { id: "9007199254740993", name: "QA 3D", type: "ThreeD" };
  const { root, runtime } = await fixture(t, {
    brokerExecutor: async (processId, envelope) => ({
      id: envelope.id,
      status: "succeeded",
      document: { path: null, uniqueId: "doc-handle", kind: "rvt" },
      changes: [`Created 3D view '${view.name}' (${view.id}).`],
      affectedFiles: [],
      affectedElements: [Number(view.id)],
      createdViews: [view],
      checks: [{ name: "transaction_commit", passed: true }],
    }),
  });

  const plain = await runtime.execute(request(root, { idempotencyKey: "view-no-result", source: "revit.create_3d_view(name='QA 3D')" }));
  assert.equal(plain.status, "succeeded", plain.error?.message);
  assert.equal(plain.result, null);
  assert.deepEqual(plain.createdViews, [view]);
  assert.equal(typeof plain.createdViews[0].id, "string");
  assert.deepEqual((await runtime.execute(request(root, { idempotencyKey: "view-no-result", source: "revit.create_3d_view(name='QA 3D')" }))).createdViews, [view]);

  const partial = await runtime.execute(request(root, {
    idempotencyKey: "view-then-raise",
    source: "revit.create_3d_view(name='QA 3D')\nraise RuntimeError('a later step failed')",
  }));
  assert.equal(partial.status, "partially_applied");
  assert.match(partial.error.message, /a later step failed/);
  assert.deepEqual(partial.createdViews, [view]);

  const history = await runtime.history.list();
  assert.deepEqual(history.find(receipt => receipt.runId === partial.runId).createdViews, [view]);
});

test("closing a document clears the selected handle for the next open or create", async (t) => {
  const envelopes = [];
  const { root, runtime } = await fixture(t, {
    brokerExecutor: async (processId, envelope) => {
      envelopes.push(envelope);
      const type = envelope.operations[0].type;
      return {
        id: envelope.id,
        status: "succeeded",
        document: { path: null, uniqueId: `doc-${envelopes.length}`, kind: type === "create_document" ? envelope.operations[0].arguments.kind : "rvt" },
        changes: [], affectedFiles: [], affectedElements: [], checks: [],
      };
    },
  });
  const receipt = await runtime.execute(request(root, {
    source: [
      "revit.create_document(templatePath=args['rte'], kind='rvt')",
      "revit.close_document()",
      "revit.create_document(templatePath=args['rft'], kind='rfa')",
      "revit.delete_document()",
      "revit.open_document(path=args['rvt'])",
    ].join("\n"),
    arguments: { rte: path.join(root, "p.rte"), rft: path.join(root, "f.rft"), rvt: path.join(root, "m.rvt") },
  }));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt.error));
  assert.deepEqual(envelopes.map(envelope => [envelope.operations[0].type, envelope.document.uniqueId]), [
    ["create_document", null],
    ["close_document", "doc-1"],
    ["create_document", null],
    ["delete_document", "doc-3"],
    ["open_document", null],
  ]);
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

test("Revit's installed content is readable without a decision but not writable", async (t) => {
  const { root, outside, runtime } = await fixture(t, { contentFolders: () => [path.join(outside, "Templates")] });
  await mkdir(path.join(outside, "Templates"));
  const template = path.join(outside, "Templates", "default.rte");
  await writeFile(template, "template");
  const read = await runtime.execute(request(root, { idempotencyKey: "content-read", source: "result = files.read(args['path'])", arguments: { path: template } }));
  assert.equal(read.status, "succeeded", read.error?.message);
  assert.equal(read.result, "template");
  assert.deepEqual(read.policyDecisionIds, []);
  const write = await runtime.execute(request(root, { idempotencyKey: "content-write", source: "files.write(args['path'], 'x')", arguments: { path: template } }));
  assert.equal(write.status, "pending");
  assert.equal((await runtime.decisions.list()).length, 1);
});

test("a stock template rides along as a grant and only the outside write needs a decision", async (t) => {
  const calls = [];
  let template;
  let target;
  const { root, outside, runtime } = await fixture(t, {
    contentFolders: () => [path.join(outside, "Templates")],
    brokerExecutor: async (processId, envelope) => {
      calls.push(envelope);
      const required = [{ operation: "create_document", paths: [template] }];
      if (envelope.operations.some(operation => operation.type === "save_as_document")) required.push({ operation: "save_as_document", paths: [target] });
      const covered = required.every(request => envelope.outsideRootApproval?.grants?.some(grant =>
        grant.operation === request.operation && request.paths.every(item => grant.paths.includes(item))));
      if (!covered) return { id: envelope.id, status: "policy_required", policyRequests: required };
      return { id: envelope.id, status: "succeeded", changes: [], affectedFiles: [], affectedElements: [], checks: [] };
    },
  });
  await mkdir(path.join(outside, "Templates"));
  template = path.join(outside, "Templates", "default.rte");
  target = path.join(outside, "model.rvt");
  await writeFile(template, "");

  const created = await runtime.execute(request(root, { idempotencyKey: "stock", source: "revit.create_document(templatePath=args['t'], kind='rvt')", arguments: { t: template } }));
  assert.equal(created.status, "succeeded", created.error?.message);
  assert.deepEqual(created.policyDecisionIds, []);
  assert.equal((await runtime.decisions.list()).length, 0);
  assert.equal(calls.at(-1).outsideRootApproval.decisionId, "revit-content");

  const source = "revit.create_document(templatePath=args['t'], kind='rvt')\nrevit.save_as_document(destinationPath=args['d'])";
  const mixed = { idempotencyKey: "mixed", source, arguments: { t: template, d: target } };
  const pending = await runtime.execute(request(root, mixed));
  assert.equal(pending.status, "pending");
  const [decision] = await runtime.decisions.list();
  assert.deepEqual(decision.requests.map(row => row.operation), ["save_as_document"]);
  await runtime.decisions.decide(decision.id, true);
  const approved = await runtime.execute(request(root, mixed));
  assert.equal(approved.status, "succeeded", approved.error?.message);
  assert.deepEqual(calls.at(-1).outsideRootApproval.grants.map(grant => grant.operation).sort(), ["create_document", "save_as_document"]);
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
  const source = "result = revit.save_as_document(destinationPath=args[\"path\"])";
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

// Flag #26 (SC-022): the worker's pipes are UTF-8 whatever the machine's locale (cp1252 on Windows).
test("non-ASCII text crosses the real worker unchanged in both directions", async (t) => {
  const name = "Niveau — 12° Café 東京";
  const envelopes = [];
  const { root, runtime } = await fixture(t, {
    brokerExecutor: async (processId, envelope) => {
      envelopes.push(envelope);
      const [operation] = envelope.operations;
      if (operation.type !== "create_level") {
        return { id: envelope.id, status: "failed", changes: [], affectedFiles: [], affectedElements: [], checks: [], error: { code: "BROKER_TEST", message: `No view named '${name}'` } };
      }
      return { id: envelope.id, status: "succeeded", changes: [`Created level '${operation.arguments.name}'`], affectedFiles: [], affectedElements: [], checks: [] };
    },
  });
  const run = (source, idempotencyKey) => runtime.execute(request(root, { source, arguments: { name }, idempotencyKey }));

  const succeeded = await run([
    "level = revit.create_level(name=args[\"name\"], elevation=4.0)",
    "print(\"printed — \" + args[\"name\"])",
    "result = {\"literal\": \"— 12° Café 東京\", \"arg\": args[\"name\"], \"broker\": level[\"changes\"][0]}",
  ].join("\n"), "utf8-succeeded");
  assert.equal(succeeded.status, "succeeded", succeeded.error?.message);
  assert.equal(envelopes[0].operations[0].arguments.name, name, "the broker receives the argument exactly");
  assert.deepEqual(succeeded.result, { literal: "— 12° Café 東京", arg: name, broker: `Created level '${name}'` });
  assert.equal(succeeded.logs, `printed — ${name}\n`);

  const raised = await run("raise RuntimeError(\"stopped — \" + args[\"name\"])", "utf8-raised");
  assert.equal(raised.status, "failed");
  assert.equal(raised.error.message, `stopped — ${name}`);

  const brokerFailed = await run("revit.read_document()", "utf8-broker-failed");
  assert.equal(brokerFailed.status, "failed");
  assert.equal(brokerFailed.error.message, `No view named '${name}'`);

  const died = await run("import os, sys\nsys.__stderr__.write(\"died — \" + args[\"name\"] + \"\\n\")\nsys.__stderr__.flush()\nos._exit(3)", "utf8-died");
  assert.equal(died.status, "failed");
  assert.match(died.error.message, new RegExp(`died — ${name}`));
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

test("package installation and process or thread execution fail inside the fixed worker", async (t) => {
  for (const source of ["import ensurepip", "import subprocess", "import ctypes", "import threading", "import _thread\n_thread.start_new_thread(lambda: None, ())", "os.system(\"echo no\")"]) {
    const { root, runtime } = await fixture(t);
    const receipt = await runtime.execute(request(root, { source: source === "os.system(\"echo no\")" ? `import os\n${source}` : source }));
    assert.equal(receipt.status, "failed", JSON.stringify(receipt));
    assert.ok(receipt.error, JSON.stringify(receipt));
    assert.match(`${receipt.error.message}${receipt.error.traceback || ""}`, /disabled/);
  }
});

test("native library calls cannot write outside the root or produce success receipts", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const target = path.join(outside, "native-escape.txt");
  await writeFile(target, "keep");
  const source = `
import os
import _ctypes
library = "msvcrt.dll" if os.name == "nt" else "libc.so.6"
libc = _ctypes.dlopen(library)
system = _ctypes.dlsym(libc, "system")
command = 'echo native-escape> "' + args["path"] + '"' if os.name == "nt" else 'printf native-escape > "' + args["path"] + '"'
result = _ctypes.call_function(system, (command.encode(),))
`;
  const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(receipt.status, "failed", JSON.stringify(receipt));
  assert.equal(receipt.error.type, "ImportError");
  assert.match(receipt.error.message, /native loading are disabled/);
  assert.equal(receipt.result, null);
  assert.equal(await readFile(target, "utf8"), "keep");
  assert.deepEqual(receipt.changes, []);
  assert.deepEqual(receipt.affectedFiles, []);
  assert.deepEqual(receipt.policyRequests, []);
  assert.deepEqual(receipt.policyDecisionIds, []);
  assert.deepEqual(await runtime.decisions.list(), []);
  assert.deepEqual(await runtime.history.get(receipt.runId), receipt);
});

test("direct extension loaders cannot bypass native loading policy or receipt effects", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const target = path.join(outside, "extension-loader-escape.txt");
  await writeFile(target, "keep");
  const source = `
import importlib.machinery
import os
directory = os.path.join(os.path.dirname(os.__file__), "DLLs" if os.name == "nt" else "lib-dynload")
extension = os.path.join(directory, "_ctypes" + importlib.machinery.EXTENSION_SUFFIXES[0])
loader = importlib.machinery.ExtensionFileLoader("_ctypes", extension)
_ctypes = loader.load_module()
library = "msvcrt.dll" if os.name == "nt" else "libc.so.6"
libc = _ctypes.dlopen(library)
system = _ctypes.dlsym(libc, "system")
command = 'echo native-escape> "' + args["path"] + '"' if os.name == "nt" else 'printf native-escape > "' + args["path"] + '"'
result = _ctypes.call_function(system, (command.encode(),))
`;
  const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(receipt.status, "failed", JSON.stringify(receipt));
  assert.equal(receipt.error.type, "ImportError");
  assert.match(receipt.error.message, /native loading are disabled/);
  assert.equal(receipt.result, null);
  assert.equal(await readFile(target, "utf8"), "keep");
  assert.deepEqual(receipt.changes, []);
  assert.deepEqual(receipt.affectedFiles, []);
  assert.deepEqual(receipt.policyRequests, []);
  assert.deepEqual(receipt.policyDecisionIds, []);
  assert.deepEqual(await runtime.decisions.list(), []);
  assert.deepEqual(await runtime.history.get(receipt.runId), receipt);
});

test("SQLite cannot create unmediated database files outside the root", async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const target = path.join(outside, "native-escape.sqlite3");
  const source = `
import sqlite3
connection = sqlite3.connect(args["path"])
connection.execute("CREATE TABLE native_escape (value TEXT)")
connection.execute("INSERT INTO native_escape VALUES ('native-escape')")
connection.commit()
connection.close()
result = "created"
`;
  const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(receipt.status, "failed", JSON.stringify(receipt));
  assert.equal(receipt.error.type, "ImportError", JSON.stringify(receipt));
  assert.match(receipt.error.message, /native loading are disabled/);
  assert.equal(receipt.result, null);
  assert.equal(await exists(target), false);
  assert.deepEqual(receipt.changes, []);
  assert.deepEqual(receipt.affectedFiles, []);
  assert.deepEqual(receipt.policyRequests, []);
  assert.deepEqual(receipt.policyDecisionIds, []);
  assert.deepEqual(await runtime.decisions.list(), []);
  assert.deepEqual(await runtime.history.get(receipt.runId), receipt);
});

test("modules outside the allowlist cannot be imported or loaded by any route", async (t) => {
  for (const [name, source] of [
    ["dbm", "import dbm\ndatabase = dbm.open(args[\"path\"], \"c\")\ndatabase[\"key\"] = \"native-escape\"\ndatabase.close()\nresult = \"created\""],
    ["dbm.gnu", "import dbm.gnu\ndatabase = dbm.gnu.open(args[\"path\"], \"c\")\ndatabase[\"key\"] = \"native-escape\"\ndatabase.close()\nresult = \"created\""],
    ["import_module", "import sys\nsys.modules[\"importlib\"].import_module(\"dbm.gnu\").open(args[\"path\"], \"c\").close()\nresult = \"created\""],
    ["pickle", "import pickle\nresult = \"imported\""],
    ["cached", "import gc\nresult = \"imported\""],
    ["relative", "from . import worker\nresult = \"imported\""],
  ]) {
    const { root, outside, runtime } = await fixture(t);
    const target = path.join(outside, `${name}.db`);
    const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
    assert.equal(receipt.status, "failed", `${name}: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.error.type, "ImportError", name);
    assert.match(receipt.error.message, /only allowlisted modules/, name);
    assert.equal(receipt.result, null, name);
    assert.equal(await exists(target), false, name);
    assert.deepEqual(receipt.changes, [], name);
    assert.deepEqual(receipt.policyRequests, [], name);
    assert.deepEqual(await runtime.decisions.list(), [], name);
  }
});

test("every allowlisted module imports from generated code", async (t) => {
  const { root, runtime } = await fixture(t);
  const source = `
import sys
allowed = sorted(sys.modules["__main__"].ALLOWED_MODULES)
for name in allowed:
    __import__(name)
result = allowed
`;
  const receipt = await runtime.execute(request(root, { source }));
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
  assert.ok(receipt.result.includes("json") && receipt.result.includes("csv"));
});

test("Windows native file handles cannot be imported", { skip: process.platform !== "win32" }, async (t) => {
  const { root, outside, runtime } = await fixture(t);
  const target = path.join(outside, "winapi-escape.txt");
  await writeFile(target, "keep");
  const source = `
import _winapi
handle = _winapi.CreateFile(args["path"], 0x40000000, 0, None, 2, 0, None)
_winapi.WriteFile(handle, b"native-escape")
_winapi.CloseHandle(handle)
result = "written"
`;
  const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
  assert.equal(receipt.status, "failed", JSON.stringify(receipt));
  assert.equal(receipt.error.type, "ImportError");
  assert.equal(await readFile(target, "utf8"), "keep");
  assert.deepEqual(receipt.changes, []);
  assert.deepEqual(await runtime.decisions.list(), []);
});

test("Windows process launches cannot write outside the root or produce success receipts", { skip: process.platform !== "win32" }, async (t) => {
  for (const [name, source] of [
    ["os.startfile", `
import os
import time
os.startfile(r"C:\\Windows\\System32\\cmd.exe", arguments='/c echo escaped > "' + args["path"] + '"')
time.sleep(1)
result = "launched"
`],
    ["_winapi.CreateProcess", `
import _winapi
import time
import types
command = r"C:\\Windows\\System32\\cmd.exe" + ' /c echo escaped > "' + args["path"] + '"'
startup = types.SimpleNamespace(dwFlags=0, wShowWindow=0, hStdInput=None, hStdOutput=None, hStdError=None, lpAttributeList=None)
process, thread, _, _ = _winapi.CreateProcess(None, command, None, None, 0, 0, None, None, startup)
_winapi.CloseHandle(thread)
_winapi.CloseHandle(process)
time.sleep(1)
result = "launched"
`],
  ]) {
    const { root, outside, runtime } = await fixture(t);
    const target = path.join(outside, `${name}.txt`);
    await writeFile(target, "keep");
    const receipt = await runtime.execute(request(root, { source, arguments: { path: target } }));
    assert.equal(receipt.status, "failed", JSON.stringify(receipt));
    assert.match(receipt.error.message, /disabled/);
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.deepEqual(receipt.changes, []);
    assert.deepEqual(receipt.affectedFiles, []);
    assert.deepEqual(await runtime.decisions.list(), []);
    assert.deepEqual(await runtime.history.get(receipt.runId), receipt);
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

test("a real worker keeps its original root when the operator root changes mid-run", async (t) => {
  let runtime;
  let secondRoot;
  let changed = false;
  const envelopes = [];
  const { base, root, runtime: configuredRuntime } = await fixture(t, {
    brokerExecutor: async (processId, envelope) => {
      envelopes.push(envelope);
      return { id: envelope.id, status: "succeeded", changes: [], affectedFiles: [], affectedElements: [], checks: [] };
    },
    workerRunner: options => runWorker({
      ...options,
      onRequest: async (method, params) => {
        const response = await options.onRequest(method, params);
        if (!changed && method === "effect.record" && params.operation === "write_file") {
          await runtime.workspace.setRoot(secondRoot);
          changed = true;
        }
        return response;
      },
    }),
  });
  runtime = configuredRuntime;
  secondRoot = path.join(base, "second-root");
  await mkdir(secondRoot);
  const firstPath = path.join(root, "first.txt");
  const secondPath = path.join(root, "second.txt");
  const receipt = await runtime.execute(request(root, {
    source: "files.write(args[\"first\"], \"one\")\nfiles.write(args[\"second\"], \"two\")\nresult = revit.read_document()",
    arguments: { first: firstPath, second: secondPath },
  }));

  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
  assert.equal(changed, true);
  assert.equal(receipt.workspaceRoot, root);
  assert.equal(await runtime.workspace.getRoot(), secondRoot);
  assert.equal(await readFile(firstPath, "utf8"), "one");
  assert.equal(await readFile(secondPath, "utf8"), "two");
  assert.deepEqual(await runtime.decisions.list(), []);
  assert.deepEqual(receipt.policyRequests, []);
  assert.deepEqual(receipt.policyDecisionIds, []);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].workspaceRoot, root);
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
