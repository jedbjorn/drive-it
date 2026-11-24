import { callOf } from "./runtime.js";

const time = receipt => receipt.completedAt || receipt.startedAt || "";

/**
 * Spec #13 "The dry run shown": the Drive-It window's Staged Actions mode shows the newest dry run in this workspace
 * that is no longer pending, whatever its outcome, with Applied once the same call (D12: same code or saved revision,
 * arguments, Revit process and target document) has since run for real and succeeded. Derived from the receipts
 * alone; nothing else is stored, so nothing but a newer completed dry run replaces it.
 */
export async function stagedDryRun(history, workspaceRoot) {
  if (!workspaceRoot) return { dryRun: null };
  const receipts = (await history.list()).filter(receipt => receipt.workspaceRoot === workspaceRoot);
  const dry = receipts
    .filter(receipt => receipt.dryRun === true && receipt.status !== "pending")
    .sort((left, right) => time(right).localeCompare(time(left)))[0];
  if (!dry) return { dryRun: null };
  const call = callOf(dry.fingerprint);
  const applied = receipts.some(receipt => receipt.dryRun !== true && receipt.status === "succeeded"
    && receipt.fingerprint === call && receipt.session?.processId === dry.session?.processId
    && time(receipt) > time(dry));
  return {
    dryRun: {
      runId: dry.runId,
      displayName: dry.displayName ?? null,
      completedAt: time(dry),
      status: dry.status,
      error: dry.error ?? null,
      document: dry.document ? { title: dry.document.title ?? null, path: dry.document.path ?? null } : null,
      rolledBack: dry.rolledBack !== false,
      applied,
      actions: dry.actions ?? [],
      images: (dry.images ?? []).map(({ viewId, name, type, path, error, message }) => ({ viewId, name, type, path: path ?? null, error: error ?? null, message: message ?? null })),
      worksharing: dry.worksharing ?? [],
    },
  };
}
