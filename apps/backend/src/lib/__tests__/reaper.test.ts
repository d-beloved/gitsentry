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
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
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

    expect(mockClaim).toHaveBeenCalledWith("scan-1", expect.stringContaining("Stranded"));
    expect(mockRefund).toHaveBeenCalledWith("org-1", "pro", "2026-08");
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

  it("honours SCAN_STRAND_TIMEOUT_MINUTES when computing the cutoff", async () => {
    mockGetStranded.mockResolvedValue([]);
    process.env.SCAN_STRAND_TIMEOUT_MINUTES = "60";

    const before = Date.now();
    await reapStrandedScans();
    delete process.env.SCAN_STRAND_TIMEOUT_MINUTES;

    const cutoff = new Date(mockGetStranded.mock.calls[0][0]).getTime();
    const expected = before - 60 * 60_000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5_000);
  });
});
