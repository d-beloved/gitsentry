// The reaper only talks to the DB and the notifier — mock both so we can assert
// the claim/refund branching without touching Supabase.
jest.mock("../../db/queries", () => ({
  getStrandedScans: jest.fn(),
  claimStrandedScan: jest.fn(),
  markScanCreditRefunded: jest.fn().mockResolvedValue(undefined),
  getOrgByRepoId: jest.fn(),
  refundScanSlot: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../notifier", () => ({
  notifyScanFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../github", () => ({
  postIncompleteCheckRun: jest.fn().mockResolvedValue(undefined),
}));

import { reapStrandedScans } from "../reaper";
import {
  getStrandedScans,
  claimStrandedScan,
  markScanCreditRefunded,
  getOrgByRepoId,
  refundScanSlot,
  type StrandedScanRow,
} from "../../db/queries";
import { notifyScanFailure } from "../notifier";
import { postIncompleteCheckRun } from "../github";

const mockGetStranded = getStrandedScans as jest.MockedFunction<typeof getStrandedScans>;
const mockClaim = claimStrandedScan as jest.MockedFunction<typeof claimStrandedScan>;
const mockMarkRefunded = markScanCreditRefunded as jest.MockedFunction<typeof markScanCreditRefunded>;
const mockGetOrg = getOrgByRepoId as jest.MockedFunction<typeof getOrgByRepoId>;
const mockRefund = refundScanSlot as jest.MockedFunction<typeof refundScanSlot>;
const mockNotify = notifyScanFailure as jest.MockedFunction<typeof notifyScanFailure>;
const mockCheckRun = postIncompleteCheckRun as jest.MockedFunction<typeof postIncompleteCheckRun>;

function strandedScan(overrides: Partial<StrandedScanRow> = {}): StrandedScanRow {
  return {
    id: "scan-1",
    repo_id: "repo-1",
    created_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    started_at: null,
    quota_claimed: true,
    credit_refunded: false,
    trigger_type: "pull_request",
    trigger_ref: "42",
    commit_sha: "abc1234def5678",
    repos: { full_name: "acme/api", installation_id: 99 },
    ...overrides,
  };
}

const ORG = {
  id: "org-1",
  plan: "pro",
  scan_month: "2026-08",
  subscription_status: "active",
} as unknown as Awaited<ReturnType<typeof getOrgByRepoId>>;

function org(overrides: Record<string, unknown>): Awaited<ReturnType<typeof getOrgByRepoId>> {
  return { ...ORG, ...overrides } as Awaited<ReturnType<typeof getOrgByRepoId>>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockGetOrg.mockResolvedValue(ORG);
  mockClaim.mockResolvedValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("reapStrandedScans", () => {
  it("does nothing when no scans are stranded", async () => {
    mockGetStranded.mockResolvedValue([]);

    expect(await reapStrandedScans()).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it("marks a stranded scan failed and refunds a claimed credit", async () => {
    mockGetStranded.mockResolvedValue([strandedScan()]);

    expect(await reapStrandedScans()).toBe(1);

    expect(mockClaim).toHaveBeenCalledWith("scan-1", expect.stringContaining("never picked up"));
    expect(mockRefund).toHaveBeenCalledWith("org-1", "pro", "2026-08", false);
    expect(mockMarkRefunded).toHaveBeenCalledWith("scan-1");
    expect(mockNotify).toHaveBeenCalledWith("repo-1", "acme/api", "pipeline_error", true, "scan-1");
  });

  it("does not refund a scan that never claimed a quota slot", async () => {
    mockGetStranded.mockResolvedValue([strandedScan({ quota_claimed: false })]);

    expect(await reapStrandedScans()).toBe(1);

    expect(mockClaim).toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not refund twice when the credit was already refunded", async () => {
    mockGetStranded.mockResolvedValue([strandedScan({ credit_refunded: true })]);

    await reapStrandedScans();

    expect(mockRefund).not.toHaveBeenCalled();
  });

  it("skips the refund when another instance won the claim", async () => {
    mockGetStranded.mockResolvedValue([strandedScan()]);
    mockClaim.mockResolvedValue(false);

    expect(await reapStrandedScans()).toBe(0);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("continues the batch when one scan throws", async () => {
    mockGetStranded.mockResolvedValue([
      strandedScan({ id: "scan-bad" }),
      strandedScan({ id: "scan-good", repo_id: "repo-2" }),
    ]);
    mockClaim.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(true);

    expect(await reapStrandedScans()).toBe(1);
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });

  it("closes out the pending check run on a reaped Pro PR scan", async () => {
    mockGetStranded.mockResolvedValue([strandedScan()]);

    await reapStrandedScans();

    expect(mockCheckRun).toHaveBeenCalledWith("acme/api", "abc1234def5678", 99, true);
  });

  it("tells the check run the credit was not refunded when it was not", async () => {
    mockGetStranded.mockResolvedValue([strandedScan({ quota_claimed: false })]);

    await reapStrandedScans();

    expect(mockCheckRun).toHaveBeenCalledWith("acme/api", "abc1234def5678", 99, false);
  });

  // Everything below never had a check run posted in the first place, so posting
  // one now would invent a red required check on a PR that had none.
  it("posts no check run for a non-Pro org", async () => {
    mockGetStranded.mockResolvedValue([strandedScan()]);
    mockGetOrg.mockResolvedValue(org({ plan: "free" }));

    await reapStrandedScans();

    expect(mockCheckRun).not.toHaveBeenCalled();
  });

  it("posts no check run for a Pro org whose subscription has lapsed", async () => {
    mockGetStranded.mockResolvedValue([strandedScan()]);
    mockGetOrg.mockResolvedValue(org({ subscription_status: "past_due" }));

    await reapStrandedScans();

    expect(mockCheckRun).not.toHaveBeenCalled();
  });

  it("posts no check run for a push scan", async () => {
    mockGetStranded.mockResolvedValue([strandedScan({ trigger_type: "push_main" })]);

    await reapStrandedScans();

    expect(mockCheckRun).not.toHaveBeenCalled();
  });

  it("posts no check run when the repo has no installation id", async () => {
    mockGetStranded.mockResolvedValue([
      strandedScan({ repos: { full_name: "acme/api", installation_id: null } }),
    ]);

    await reapStrandedScans();

    expect(mockCheckRun).not.toHaveBeenCalled();
  });

  it("still reaps and refunds when GitHub rejects the check run", async () => {
    mockGetStranded.mockResolvedValue([strandedScan()]);
    mockCheckRun.mockRejectedValueOnce(new Error("422 unprocessable"));

    expect(await reapStrandedScans()).toBe(1);
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });

  it("falls back to the repo id when the joined repo row is missing", async () => {
    mockGetStranded.mockResolvedValue([strandedScan({ repos: null })]);

    await reapStrandedScans();

    expect(mockNotify).toHaveBeenCalledWith("repo-1", "repo-1", "pipeline_error", true, "scan-1");
  });

  it("describes a mid-run death differently from a job that was never picked up", async () => {
    mockGetStranded.mockResolvedValue([
      strandedScan({ started_at: new Date(Date.now() - 20 * 60_000).toISOString() }),
    ]);

    await reapStrandedScans();

    expect(mockClaim).toHaveBeenCalledWith("scan-1", expect.stringContaining("worker died mid-run"));
  });

  it("passes both cutoffs, and they honour their own env vars", async () => {
    mockGetStranded.mockResolvedValue([]);
    process.env.SCAN_QUEUE_TIMEOUT_MINUTES = "90";
    process.env.SCAN_STRAND_TIMEOUT_MINUTES = "20";

    const before = Date.now();
    await reapStrandedScans();
    delete process.env.SCAN_QUEUE_TIMEOUT_MINUTES;
    delete process.env.SCAN_STRAND_TIMEOUT_MINUTES;

    const [queueCutoff, runCutoff] = mockGetStranded.mock.calls[0];
    expect(Math.abs(new Date(queueCutoff).getTime() - (before - 90 * 60_000))).toBeLessThan(5_000);
    expect(Math.abs(new Date(runCutoff).getTime() - (before - 20 * 60_000))).toBeLessThan(5_000);
  });

  it("defaults the queue clock well past the run clock", async () => {
    mockGetStranded.mockResolvedValue([]);

    await reapStrandedScans();

    // A generous queue threshold is the whole defence against reaping a scan
    // that is merely waiting its turn behind a slow backlog.
    const [queueCutoff, runCutoff] = mockGetStranded.mock.calls[0];
    expect(new Date(queueCutoff).getTime()).toBeLessThan(new Date(runCutoff).getTime());
  });
});
