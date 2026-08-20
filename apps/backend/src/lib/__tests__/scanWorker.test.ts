// The worker's terminal-error branch is the one path that runs *after* a scan
// has already failed, so a bug in it replaces the real cause with its own. The
// db/github/notifier layers are mocked to nothing: the assertions here are
// entirely about which error comes out and whether the job was discarded.
jest.mock("../../db/queries", () => ({
  markScanStarted: jest.fn().mockResolvedValue(true),
  getOrgByRepoId: jest.fn(),
  getScanRefundState: jest.fn().mockResolvedValue({quotaClaimed: false, creditRefunded: true}),
  updateScanStatus: jest.fn().mockResolvedValue(false),
  refundScanSlot: jest.fn().mockResolvedValue(undefined),
  saveFindings: jest.fn(),
  tryClaimScan: jest.fn(),
  getPreviousPRCommentId: jest.fn(),
  getOpenPRFindings: jest.fn(),
  updateScanCommentId: jest.fn(),
  recordAiUsage: jest.fn(),
  scanQuotaAlreadyClaimed: jest.fn(),
  markScanQuotaClaimed: jest.fn(),
}));
jest.mock("../github", () => ({
  postPRReview: jest.fn(),
  postCommitComment: jest.fn(),
  postCheckRun: jest.fn(),
  postUpgradeComment: jest.fn(),
  postSkippedCheckRun: jest.fn(),
  postIncompleteCheckRun: jest.fn().mockResolvedValue(undefined),
  postSubscriptionPausedComment: jest.fn(),
  hasRequiredCheck: jest.fn().mockReturnValue(false),
  setupBranchProtection: jest.fn(),
}));
jest.mock("../notifier", () => ({
  notifyIfNeeded: jest.fn(),
  notifyScanFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../securityContext", () => ({resolveSecurityContext: jest.fn()}));
jest.mock("../differ", () => ({extractScannablePaths: jest.fn().mockReturnValue([])}));

import type Bull from "bull";
import processor from "../workers/scanWorker";
import { AITimeoutError } from "../aiDeadline";
import { getOrgByRepoId } from "../../db/queries";
import type { ScanJobData } from "../../../../../packages/scanner-contract/types";

const mockGetOrg = getOrgByRepoId as jest.MockedFunction<typeof getOrgByRepoId>;

function fakeJob(): Bull.Job<ScanJobData> & {discard: jest.Mock} {
  return {
    id: 45,
    attemptsMade: 0,
    opts: {attempts: 3},
    discard: jest.fn(),
    data: {
      scanId: "scan-1",
      repoId: "repo-1",
      repoFullName: "acme/api",
      diff: "diff --git a/a.ts b/a.ts",
      context: {repo: "acme/api", branch: "main", triggerType: "push", author: null},
      installationId: 1,
      prNumber: null,
      commitSha: null,
      branch: "main",
      triggerType: "push",
    },
  } as unknown as Bull.Job<ScanJobData> & {discard: jest.Mock};
}

beforeEach(() => {
  jest.clearAllMocks();
  // The failure path calls getOrgByRepoId a second time to look up the org for
  // a refund; only the first call is the one under test.
  mockGetOrg.mockResolvedValue(null);
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("scanWorkerProcessor terminal errors", () => {
  it("discards the job and rethrows the original AI timeout", async () => {
    const job = fakeJob();
    const timeout = new AITimeoutError("[ai] AI call timed out after 120s");
    mockGetOrg.mockRejectedValueOnce(timeout);

    // Bull reads the failure off the rejection, so the error that surfaces here
    // is the one the customer and the logs get. discard() is synchronous and
    // returns undefined — treating it as a promise threw a TypeError that
    // replaced the timeout with "Cannot read properties of undefined".
    await expect(processor(job)).rejects.toBe(timeout);
    expect(job.discard).toHaveBeenCalledTimes(1);
  });

  it("leaves a retryable error alone", async () => {
    const job = fakeJob();
    const transient = new Error("supabase unreachable");
    mockGetOrg.mockRejectedValueOnce(transient);

    await expect(processor(job)).rejects.toBe(transient);
    expect(job.discard).not.toHaveBeenCalled();
  });
});
