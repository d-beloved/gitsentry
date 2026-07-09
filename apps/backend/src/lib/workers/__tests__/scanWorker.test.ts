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
  setupBranchProtection: jest.fn().mockResolvedValue(undefined),
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
  updateScanStatus: jest.fn().mockResolvedValue(undefined),
  getOrgByRepoId: jest.fn(),
  tryClaimScan: jest.fn(),
  getPreviousPRCommentId: jest.fn().mockResolvedValue(null),
  updateScanCommentId: jest.fn().mockResolvedValue(undefined),
  recordAiUsage: jest.fn().mockResolvedValue(undefined),
  scanQuotaAlreadyClaimed: jest.fn().mockResolvedValue(false),
  markScanQuotaClaimed: jest.fn().mockResolvedValue(undefined),
  refundScanSlot: jest.fn().mockResolvedValue(undefined),
}));

import { processScanJob } from "../scanWorker";
import { analyzeCode } from "../../ai";
import {
  updateScanStatus,
  getOrgByRepoId,
  tryClaimScan,
  refundScanSlot,
  scanQuotaAlreadyClaimed,
} from "../../../db/queries";
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

beforeEach(() => jest.clearAllMocks());

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
    // First check (in the claim path) sees no prior claim; after the worker
    // claims + marks it, the catch-block re-check sees the slot as claimed.
    (scanQuotaAlreadyClaimed as jest.Mock).mockResolvedValueOnce(false).mockResolvedValue(true);
    (analyzeCode as jest.Mock).mockRejectedValue(new Error("gemini exploded"));

    await expect(processScanJob(baseJob)).rejects.toThrow("gemini exploded");

    expect(refundScanSlot).toHaveBeenCalledWith("org-1", "starter", "2026-07");
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
      issues: [], summary: "clean", tokens_in: 10, tokens_out: 5, model_name: "gemini-2.5-flash", coverage: null,
    });

    await processScanJob(baseJob);

    expect(refundScanSlot).not.toHaveBeenCalled();
    expect(notifyScanFailure).not.toHaveBeenCalled();
    expect(updateScanStatus).toHaveBeenLastCalledWith(
      "scan-1", [], expect.any(Number), "complete",
      { tokensIn: 10, tokensOut: 5, modelName: "gemini-2.5-flash" },
    );
  });
});
