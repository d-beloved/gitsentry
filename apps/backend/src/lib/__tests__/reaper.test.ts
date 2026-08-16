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

const mockGetStranded = getStrandedScans as jest.MockedFunction<typeof getStrandedScans>;
const mockClaim = claimStrandedScan as jest.MockedFunction<typeof claimStrandedScan>;
const mockMarkRefunded = markScanCreditRefunded as jest.MockedFunction<typeof markScanCreditRefunded>;
const mockGetOrg = getOrgByRepoId as jest.MockedFunction<typeof getOrgByRepoId>;
const mockRefund = refundScanSlot as jest.MockedFunction<typeof refundScanSlot>;
const mockNotify = notifyScanFailure as jest.MockedFunction<typeof notifyScanFailure>;

function strandedScan(overrides: Partial<StrandedScanRow> = {}): StrandedScanRow {
  return {
    id: "scan-1",
    repo_id: "repo-1",
    created_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    started_at: null,
    quota_claimed: true,
    credit_refunded: false,
    repos: { full_name: "acme/api" },
    ...overrides,
  };
}

const ORG = {
  id: "org-1",
  plan: "pro",
  scan_month: "2026-08",
} as unknown as Awaited<ReturnType<typeof getOrgByRepoId>>;

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
