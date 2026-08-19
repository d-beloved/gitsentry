// handlePR decides, for every PR it declines to scan, whether a required check
// is left hanging on the commit. These tests cover that decision; the scanning
// path itself is covered by scanWorker.test.ts.
jest.mock("../../lib/github", () => ({
  getDiff: jest.fn(),
  getIncrementalDiff: jest.fn(),
  postBotPRSkipComment: jest.fn().mockResolvedValue(undefined),
  postSyncSkipComment: jest.fn().mockResolvedValue(undefined),
  postSubscriptionPausedComment: jest.fn().mockResolvedValue(1),
  postSkippedCheckRun: jest.fn().mockResolvedValue(undefined),
  // Real implementation: which orgs it admits is the thing under test.
  hasRequiredCheck: jest.requireActual("../../lib/github").hasRequiredCheck,
}));
jest.mock("../../db/queries", () => ({
  saveScan: jest.fn().mockResolvedValue({id: "scan-1", repo_id: "repo-1"}),
  updateScanStatus: jest.fn().mockResolvedValue(true),
  getOrgByInstallationId: jest.fn(),
  scanExistsForCommit: jest.fn().mockResolvedValue(false),
  getLastPRScanResult: jest.fn().mockResolvedValue(null),
  getPreviousPRCommentId: jest.fn().mockResolvedValue(null),
  updateScanCommentId: jest.fn().mockResolvedValue(undefined),
  getRepoIdByFullName: jest.fn().mockResolvedValue("repo-1"),
}));
jest.mock("../../lib/queue", () => ({
  dispatchScan: jest.fn(),
}));

import { handlePR } from "../pullRequest";
import { getDiff, postSkippedCheckRun } from "../../lib/github";
import { getOrgByInstallationId, scanExistsForCommit } from "../../db/queries";
import { dispatchScan } from "../../lib/queue";

const PRO = {id: "org-1", plan: "pro", subscription_status: "active"};
const FREE = {id: "org-1", plan: "free", subscription_status: "active"};

const CODE_DIFF = [
  "diff --git a/src/api.ts b/src/api.ts",
  "index 111..222 100644",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -1,2 +1,3 @@",
  " const x = 1;",
  "+const token = req.query.token;",
].join("\n");

const LOCKFILE_DIFF = [
  "diff --git a/yarn.lock b/yarn.lock",
  "index 111..222 100644",
  "--- a/yarn.lock",
  "+++ b/yarn.lock",
  "@@ -1,2 +1,3 @@",
  " lodash@^4.0.0:",
  '+  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
].join("\n");

function payload(over: {login?: string; type?: string; title?: string; ref?: string; action?: string; private?: boolean} = {}): Record<string, unknown> {
  return {
    action: over.action ?? "opened",
    pull_request: {
      number: 7,
      title: over.title ?? "Add token check",
      user: {login: over.login ?? "dev", type: over.type ?? "User"},
      head: {sha: "abc1234", ref: over.ref ?? "feat/x"},
    },
    repository: {
      id: 555,
      full_name: "acme/app",
      private: over.private ?? false,
      owner: {id: 1, login: "acme", avatar_url: null},
    },
    installation: {id: 42},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  (scanExistsForCommit as jest.Mock).mockResolvedValue(false);
  (getOrgByInstallationId as jest.Mock).mockResolvedValue(PRO);
  (getDiff as jest.Mock).mockResolvedValue(CODE_DIFF);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// The check run is posted from a floating async IIFE so a GitHub hiccup can
// never fail the webhook; let its microtasks drain before asserting.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("handlePR — releasing a required check on skips", () => {
  it("releases the check for a dependency-bot PR on a Pro repo", async () => {
    // The bug that made this whole change urgent: dependency bots are skipped on
    // every plan, so every Dependabot PR on a Pro repo was unmergeable.
    await handlePR(payload({login: "dependabot[bot]", type: "Bot"}));
    await flush();

    expect(dispatchScan).not.toHaveBeenCalled();
    expect(postSkippedCheckRun).toHaveBeenCalledWith("acme/app", "abc1234", 42, "dependency_bot");
  });

  it("posts nothing for a dependency-bot PR on a free repo, which has no required check", async () => {
    (getOrgByInstallationId as jest.Mock).mockResolvedValue(FREE);

    await handlePR(payload({login: "dependabot[bot]", type: "Bot"}));
    await flush();

    expect(postSkippedCheckRun).not.toHaveBeenCalled();
  });

  it("releases the check for a release-automation PR", async () => {
    await handlePR(payload({login: "release-please[bot]", type: "Bot", title: "chore(main): release 1.2.0"}));
    await flush();

    expect(postSkippedCheckRun).toHaveBeenCalledWith("acme/app", "abc1234", 42, "release_automation");
  });

  it("releases the check for a lockfile-only diff", async () => {
    (getDiff as jest.Mock).mockResolvedValue(LOCKFILE_DIFF);

    await handlePR(payload());
    await flush();

    expect(dispatchScan).not.toHaveBeenCalled();
    expect(postSkippedCheckRun).toHaveBeenCalledWith("acme/app", "abc1234", 42, "no_scannable_changes");
  });

  it("releases the check when there is no diff at all", async () => {
    (getDiff as jest.Mock).mockResolvedValue("");

    await handlePR(payload());
    await flush();

    expect(postSkippedCheckRun).toHaveBeenCalledWith("acme/app", "abc1234", 42, "no_scannable_changes");
  });

  it("releases the check on a private repo whose subscription lapsed", async () => {
    (getOrgByInstallationId as jest.Mock).mockResolvedValue({
      id: "org-1", plan: "free", subscription_status: "past_due",
    });

    await handlePR(payload({private: true}));
    await flush();

    expect(postSkippedCheckRun).toHaveBeenCalledWith(
      "acme/app", "abc1234", 42, "subscription_inactive",
    );
  });

  it("posts nothing on a redelivered webhook — the first delivery already reported", async () => {
    (scanExistsForCommit as jest.Mock).mockResolvedValue(true);

    await handlePR(payload({login: "dependabot[bot]", type: "Bot"}));
    await flush();

    expect(postSkippedCheckRun).not.toHaveBeenCalled();
  });

  it("scans a normal PR and leaves the check to the scan", async () => {
    await handlePR(payload());
    await flush();

    expect(dispatchScan).toHaveBeenCalled();
    expect(postSkippedCheckRun).not.toHaveBeenCalled();
  });

  it("does not let a GitHub failure escape the webhook", async () => {
    (postSkippedCheckRun as jest.Mock).mockRejectedValue(new Error("403 forbidden"));

    await expect(
      handlePR(payload({login: "dependabot[bot]", type: "Bot"})),
    ).resolves.toBeUndefined();
    await flush();
  });
});
