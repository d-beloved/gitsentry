import {postPRReview} from "./github";
import {
  getFindingRefs,
  getLatestPRCommentScan,
  getOpenPRFindings,
  type PRCommentTarget,
} from "../db/queries";
import type {Finding} from "../../../../packages/scanner-contract/types";

function refLabel(ref: {trigger_type: string; trigger_ref: string}): string {
  if (ref.trigger_type === "pull_request") return `PR #${ref.trigger_ref}`;
  if (ref.trigger_type === "push_main") return "main";
  return `\`${ref.trigger_ref}\``;
}

/** duplicate_of id → the other PR (or main) where that issue is already written up. */
export async function trackedElsewhere(findings: Finding[], prNumber: number): Promise<Map<string, string>> {
  const ids = [...new Set(findings.map((f) => f.duplicate_of).filter((id): id is string => !!id))];
  const refs = await getFindingRefs(ids);
  const out = new Map<string, string>();
  for (const [id, ref] of refs) {
    const isThisPR = ref.trigger_type === "pull_request" && ref.trigger_ref === String(prNumber);
    if (!isThisPR) out.set(id, refLabel(ref));
  }
  return out;
}

export const REFRESH_SUMMARY = "Updated after findings were resolved or dismissed on the dashboard.";

/**
 * Rewrites the PR's comment from the findings still open on it. Leaves a comment owned by a
 * skipped or in-flight scan alone: that one is an upgrade/paused notice or about to be replaced.
 */
export async function refreshPRComment(target: PRCommentTarget): Promise<boolean> {
  const current = await getLatestPRCommentScan(target.repoId, target.prNumber);
  if (!current || current.status !== "complete") return false;

  const open = await getOpenPRFindings(target.repoId, target.prNumber);
  const trackedIn = await trackedElsewhere(open, target.prNumber);

  await postPRReview(
    target.repoFullName,
    target.prNumber,
    open,
    [],
    REFRESH_SUMMARY,
    current.scanId,
    target.installationId,
    current.commentId,
    undefined,
    trackedIn,
  );
  return true;
}
