import type { ScanJobData } from "../../../../../../packages/scanner-contract/types";

// The worker pulls in AI, GitHub, DB and notifier modules that all hit external
// services. Mock them so we can assert the outcome/refund branching in isolation.
jest.mock("../../ai", () => ({
  analyzeCode: jest.fn(),
}));
jest.mock("../../github", () => ({
  postPRReview: jest.fn().mockResolvedValue(123),
  postCommitComment: jest.fn().mockResolvedValue(undefined),
  postCheckRun: jest.fn().mockResolvedValue(undefined),
  postUpgradeComment: jest.fn().mockResolvedValue(undefined),
  postSkippedCheckRun: jest.fn().mockResolvedValue(undefined),
  postIncompleteCheckRun: jest.fn().mockResolvedValue(undefined),
  postSubscriptionPausedComment: jest.fn().mockResolvedValue(456),
  setupBranchProtection: jest.fn().mockResolvedValue(undefined),
  // Real implementation: it is pure plan/subscription logic, and which orgs it
  // admits is exactly what the check-run tests below are asserting.
  hasRequiredCheck: jest.requireActual("../../github").hasRequiredCheck,
}));
jest.mock("../../securityContext", () => ({
  resolveSecurityContext: jest.fn().mockResolvedValue({ repoSecurityContext: "", classification: undefined }),
}));
jest.mock("../../notifier", () => ({
  notifyIfNeeded: jest.fn().mockResolvedValue(undefined),
  notifyScanFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../db/queries", () => ({
  saveFindings: jest.fn().mockResolvedValue([]),
  // Returns true = "the row was written". A reaped row returns false, which is
  // what stops the worker refunding or notifying a second time.
  updateScanStatus: jest.fn().mockResolvedValue(true),
  getOrgByRepoId: jest.fn(),
  tryClaimScan: jest.fn(),
  getPreviousPRCommentId: jest.fn().mockResolvedValue(null),
  getOpenPRFindings: jest.fn().mockResolvedValue([]),
  updateScanCommentId: jest.fn().mockResolvedValue(undefined),
  recordAiUsage: jest.fn().mockResolvedValue(undefined),
  scanQuotaAlreadyClaimed: jest.fn().mockResolvedValue(false),
  markScanQuotaClaimed: jest.fn().mockResolvedValue(undefined),
  refundScanSlot: jest.fn().mockResolvedValue(undefined),
  // Default: we still own the scan and it has no prior refund.
  markScanStarted: jest.fn().mockResolvedValue(true),
  getScanRefundState: jest.fn().mockResolvedValue({quotaClaimed: false, creditRefunded: false}),
}));

import { processScanJob } from "../scanWorker";
import { analyzeCode } from "../../ai";
import {
  updateScanStatus,
  getOrgByRepoId,
  tryClaimScan,
  refundScanSlot,
  scanQuotaAlreadyClaimed,
  markScanStarted,
  getScanRefundState,
  getPreviousPRCommentId,
  getOpenPRFindings,
} from "../../../db/queries";
import {
  postPRReview,
  postCheckRun,
  postSkippedCheckRun,
  postIncompleteCheckRun,
  postSubscriptionPausedComment,
} from "../../github";
import { notifyScanFailure } from "../../notifier";

const baseJob: ScanJobData = {
  scanId: "scan-1",
  repoId: "repo-1",
  repoFullName: "acme/app",
  diff: "diff --git a/x b/x\n+const a = 1;",
  context: { repo: "acme/app", branch: "feat", triggerType: "pull_request", author: "dev" },
  installationId: 42,
  prNumber: 7,
  commitSha: "abc1234",
  branch: "feat",
  triggerType: "pull_request",
  quotaAlreadyClaimed: false,
} as ScanJobData;

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes call history but leaves implementations in place, so a
  // test that overrides one of these would otherwise leak into every test after
  // it. Re-establish the happy-path defaults each time.
  (markScanStarted as jest.Mock).mockResolvedValue(true);
  (updateScanStatus as jest.Mock).mockResolvedValue(true);
  (scanQuotaAlreadyClaimed as jest.Mock).mockResolvedValue(false);
  (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: false, creditRefunded: false});
  (getPreviousPRCommentId as jest.Mock).mockResolvedValue(null);
  (getOpenPRFindings as jest.Mock).mockResolvedValue([]);
});

describe("processScanJob — scan outcomes", () => {
  it("skips (not fails) when the subscription has lapsed, without claiming a credit", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "free", subscription_status: "canceled", scan_month: "2026-07",
    });

    await processScanJob(baseJob);

    expect(tryClaimScan).not.toHaveBeenCalled();
    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-1", [], 0, "skipped", { failureReason: "subscription_inactive" },
    );
  });

  it("skips with quota_exceeded when the monthly limit is reached", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "free", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(false);

    await processScanJob(baseJob);

    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-1", [], 0, "skipped", { failureReason: "quota_exceeded" },
    );
  });

  it("refunds the credit and notifies when the pipeline errors after claiming a slot", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "starter", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (scanQuotaAlreadyClaimed as jest.Mock).mockResolvedValue(false);
    // After the worker claims + marks it, the catch block sees a claimed slot
    // that has not yet been refunded.
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: true, creditRefunded: false});
    (analyzeCode as jest.Mock).mockRejectedValue(new Error("gemini exploded"));

    await expect(processScanJob(baseJob)).rejects.toThrow("gemini exploded");

    expect(refundScanSlot).toHaveBeenCalledWith("org-1", "starter", "2026-07", false);
    expect(updateScanStatus).toHaveBeenLastCalledWith(
      "scan-1", [], expect.any(Number), "failed",
      { failureReason: "pipeline_error", creditRefunded: true, errorDetail: expect.stringContaining("gemini exploded") },
    );
    expect(notifyScanFailure).toHaveBeenCalledWith("repo-1", "acme/app", "pipeline_error", true, "scan-1");
  });

  it("marks a clean scan complete and never touches refunds", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "starter", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (analyzeCode as jest.Mock).mockResolvedValue({
      issues: [], summary: "clean", tokens_in: 10, tokens_out: 5, model_name: "test-model", coverage: null,
    });

    await processScanJob(baseJob);

    expect(refundScanSlot).not.toHaveBeenCalled();
    expect(notifyScanFailure).not.toHaveBeenCalled();
    expect(updateScanStatus).toHaveBeenLastCalledWith(
      "scan-1", [], expect.any(Number), "complete",
      { tokensIn: 10, tokensOut: 5, modelName: "test-model", examinedPaths: [] },
    );
  });
});

describe("processScanJob — reaped scans", () => {
  it("abandons the job without scanning when the reaper already closed the row", async () => {
    (markScanStarted as jest.Mock).mockResolvedValue(false);

    await expect(processScanJob(baseJob)).resolves.toBeUndefined();

    // The whole point: no AI spend, no status write, no second refund, and no
    // throw (which would send it back through Bull's retry).
    expect(analyzeCode).not.toHaveBeenCalled();
    expect(updateScanStatus).not.toHaveBeenCalled();
    expect(refundScanSlot).not.toHaveBeenCalled();
    expect(notifyScanFailure).not.toHaveBeenCalled();
  });

  it("does not refund when the failing row was reaped mid-run", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "starter", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: true, creditRefunded: false});
    (analyzeCode as jest.Mock).mockRejectedValue(new Error("gemini exploded"));
    // The reaper took the row while the scan was running, so the guarded write
    // finds nothing to update.
    (updateScanStatus as jest.Mock).mockResolvedValue(false);

    await expect(processScanJob(baseJob)).rejects.toThrow("gemini exploded");

    // The reaper already refunded this credit — refunding again would hand out
    // a free scan.
    expect(refundScanSlot).not.toHaveBeenCalled();
    expect(notifyScanFailure).not.toHaveBeenCalled();
  });
});

describe("processScanJob — refund is once per claimed slot", () => {
  beforeEach(() => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "starter", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (analyzeCode as jest.Mock).mockRejectedValue(new Error("gemini exploded"));
  });

  it("does not refund again on a Bull retry of an already-refunded scan", async () => {
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: true, creditRefunded: true});

    await expect(processScanJob(baseJob)).rejects.toThrow("gemini exploded");

    expect(refundScanSlot).not.toHaveBeenCalled();
    expect(updateScanStatus).toHaveBeenLastCalledWith(
      "scan-1", [], expect.any(Number), "failed",
      expect.objectContaining({ creditRefunded: false }),
    );
  });

  it("holds the slot when another attempt is still coming", async () => {
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: true, creditRefunded: false});

    await expect(
      processScanJob(baseJob, { isFinalAttempt: () => false }),
    ).rejects.toThrow("gemini exploded");

    // Releasing it here is what produced free scans: attempt 2 completes, and
    // the success path never re-takes the slot.
    expect(refundScanSlot).not.toHaveBeenCalled();
    expect(notifyScanFailure).not.toHaveBeenCalled();
    expect(updateScanStatus).toHaveBeenLastCalledWith(
      "scan-1", [], expect.any(Number), "failed",
      expect.objectContaining({ creditRefunded: false }),
    );
  });

  it("refunds once the last attempt fails", async () => {
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: true, creditRefunded: false});

    await expect(
      processScanJob(baseJob, { isFinalAttempt: () => true }),
    ).rejects.toThrow("gemini exploded");

    expect(refundScanSlot).toHaveBeenCalledWith("org-1", "starter", "2026-07", false);
    expect(notifyScanFailure).toHaveBeenCalled();
  });

  it("still refunds a caller-claimed slot, which never sets quota_claimed on the row", async () => {
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: false, creditRefunded: false});

    await expect(
      processScanJob({ ...baseJob, quotaAlreadyClaimed: true }),
    ).rejects.toThrow("gemini exploded");

    expect(refundScanSlot).toHaveBeenCalledWith("org-1", "starter", "2026-07", false);
  });
});

// A `synchronize` scan reads only the incremental diff. Before this, a follow-up
// commit touching one unrelated file made the scan report zero findings, and the
// worker rewrote the PR comment to "No security issues found" — retiring a real
// HIGH nobody had fixed. The scan's blind spot must never read as an all-clear.
describe("processScanJob — findings from earlier commits", () => {
  // Touches src/x.ts and nothing else.
  const incrementalDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "index 1111111..2222222 100644",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1 +1,2 @@",
    " const a = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  const openHigh = {
    id: "finding-1",
    severity: "high",
    category: "missing_auth",
    file_path: "api/rebuild.ts",
    line_number: 28,
    code_snippet: null,
    description: "Unauthenticated rebuild trigger",
    fix_suggestion: "Require the shared secret",
  };

  const syncJob = { ...baseJob, diff: incrementalDiff };

  beforeEach(() => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "pro", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (analyzeCode as jest.Mock).mockResolvedValue({
      issues: [], summary: "clean", tokens_in: 1, tokens_out: 1, model_name: "m", coverage: null,
    });
    (getPreviousPRCommentId as jest.Mock).mockResolvedValue({commentId: 999, hadFindings: true});
  });

  it("reprints an open finding the scan never re-read instead of reporting clean", async () => {
    (getOpenPRFindings as jest.Mock).mockResolvedValue([openHigh]);

    await processScanJob(syncJob);

    expect(postPRReview).toHaveBeenCalledTimes(1);
    // 4th arg is `carried` — the finding survives into the updated comment.
    expect((postPRReview as jest.Mock).mock.calls[0][3]).toEqual([openHigh]);
  });

  it("keeps the Pro check run red while a carried finding stands", async () => {
    (getOpenPRFindings as jest.Mock).mockResolvedValue([openHigh]);

    await processScanJob(syncJob);

    expect((postCheckRun as jest.Mock).mock.calls[0][3]).toEqual([openHigh]);
  });

  it("supersedes only the files it actually examined", async () => {
    (getOpenPRFindings as jest.Mock).mockResolvedValue([openHigh]);

    await processScanJob(syncJob);

    expect(updateScanStatus).toHaveBeenLastCalledWith(
      "scan-1", [], expect.any(Number), "complete",
      expect.objectContaining({ examinedPaths: ["src/x.ts"] }),
    );
  });

  it("lets a finding go once a commit touches the file it lives in", async () => {
    // Same scan, but this time the diff covers the file the finding is in and
    // the scanner no longer reports it — that is a real fix, so it clears.
    (getOpenPRFindings as jest.Mock).mockResolvedValue([
      { ...openHigh, file_path: "src/x.ts" },
    ]);

    await processScanJob(syncJob);

    expect((postPRReview as jest.Mock).mock.calls[0][3]).toEqual([]);
    expect((postCheckRun as jest.Mock).mock.calls[0][3]).toEqual([]);
  });

  it("still skips the redundant update when nothing is open and the comment is already clean", async () => {
    (getPreviousPRCommentId as jest.Mock).mockResolvedValue({commentId: 999, hadFindings: false});
    (getOpenPRFindings as jest.Mock).mockResolvedValue([]);

    await processScanJob(syncJob);

    expect(postPRReview).not.toHaveBeenCalled();
  });

  it("updates a comment that is showing carried findings once they are gone", async () => {
    // The previous scan reported nothing of its own (hadFindings false) but its
    // comment was displaying a carried finding. That finding has since been
    // fixed, so the comment has to be refreshed rather than left frozen.
    (getPreviousPRCommentId as jest.Mock).mockResolvedValue({commentId: 999, hadFindings: false});
    (getOpenPRFindings as jest.Mock).mockResolvedValue([
      { ...openHigh, file_path: "src/x.ts" },
    ]);

    await processScanJob(syncJob);

    expect(postPRReview).toHaveBeenCalledTimes(1);
    expect((postPRReview as jest.Mock).mock.calls[0][3]).toEqual([]);
  });
});

// A repo where our check is required blocks the merge until *something* reports
// on the head sha. Every early return below used to report nothing, which left
// the PR on "Expected — waiting for status to be reported" permanently. These
// assert both halves of the policy: benign skips resolve the check so the PR can
// merge, a scan that failed holds it.
describe("processScanJob — required check resolution", () => {
  const PRO = {
    id: "org-1", plan: "pro", subscription_status: "active", scan_month: "2026-07",
  };

  // The paused comment is posted from a floating async IIFE so it never blocks
  // the skip; let its microtasks drain before asserting.
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  it("releases the check when a Pro org is out of scans", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue(PRO);
    (tryClaimScan as jest.Mock).mockResolvedValue(false);

    await processScanJob(baseJob);

    expect(postSkippedCheckRun).toHaveBeenCalledWith(
      "acme/app", "abc1234", 42, "quota_exceeded", { plan: "pro", limit: 500 },
    );
  });

  it("posts nothing for a free org out of scans — no required check exists to release", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "free", subscription_status: "active", scan_month: "2026-07",
    });
    (tryClaimScan as jest.Mock).mockResolvedValue(false);

    await processScanJob(baseJob);

    expect(postSkippedCheckRun).not.toHaveBeenCalled();
  });

  it("releases the check and says so on the PR when the subscription has lapsed", async () => {
    // Paddle sets plan:"free" on lapse, but the branch protection we set up
    // while they were paying is still there — so the check still has to resolve.
    (getOrgByRepoId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "free", subscription_status: "canceled", scan_month: "2026-07",
    });

    await processScanJob(baseJob);
    await flush();

    expect(postSkippedCheckRun).toHaveBeenCalledWith(
      "acme/app", "abc1234", 42, "subscription_inactive", undefined,
    );
    expect(postSubscriptionPausedComment).toHaveBeenCalledWith("acme/app", 7, 42, null);
  });

  it("releases the check when the installation has no org record", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue(null);

    await processScanJob(baseJob);

    // Deliberately ungated: with no org we cannot tell whether the repo carries
    // our check, and guessing wrong strands a PR nobody can merge.
    expect(postSkippedCheckRun).toHaveBeenCalledWith("acme/app", "abc1234", 42, "no_org");
  });

  it("holds the check with a red result when the scan itself failed", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue(PRO);
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (getScanRefundState as jest.Mock).mockResolvedValue({quotaClaimed: true, creditRefunded: false});
    (analyzeCode as jest.Mock).mockRejectedValue(new Error("gemini exploded"));

    await expect(processScanJob(baseJob)).rejects.toThrow("gemini exploded");

    expect(postIncompleteCheckRun).toHaveBeenCalledWith("acme/app", "abc1234", 42, true);
    expect(postSkippedCheckRun).not.toHaveBeenCalled();
  });

  it("waits for the last attempt before posting a red check", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue(PRO);
    (tryClaimScan as jest.Mock).mockResolvedValue(true);
    (analyzeCode as jest.Mock).mockRejectedValue(new Error("transient"));

    await expect(
      processScanJob(baseJob, { isFinalAttempt: () => false }),
    ).rejects.toThrow("transient");

    // Otherwise attempt 1's red check sits in the PR next to attempt 3's green.
    expect(postIncompleteCheckRun).not.toHaveBeenCalled();
  });

  it("posts no check run for a push scan, which never had one", async () => {
    (getOrgByRepoId as jest.Mock).mockResolvedValue(PRO);
    (tryClaimScan as jest.Mock).mockResolvedValue(false);

    await processScanJob({ ...baseJob, prNumber: null, triggerType: "push_main" } as ScanJobData);

    expect(postSkippedCheckRun).not.toHaveBeenCalled();
  });
});
