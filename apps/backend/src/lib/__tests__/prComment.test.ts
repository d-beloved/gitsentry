jest.mock("../github", () => ({postPRReview: jest.fn().mockResolvedValue(555)}));
jest.mock("../../db/queries", () => ({
  getFindingRefs: jest.fn(),
  getLatestPRCommentScan: jest.fn(),
  getOpenPRFindings: jest.fn(),
}));

import {refreshPRComment, REFRESH_SUMMARY} from "../prComment";
import {postPRReview} from "../github";
import {getFindingRefs, getLatestPRCommentScan, getOpenPRFindings} from "../../db/queries";

const target = {repoId: "r1", prNumber: 7, repoFullName: "acme/app", installationId: 42};
const finding = (id: string, duplicate_of: string | null = null) =>
  ({id, duplicate_of, severity: "high", category: "xss", file_path: "a.ts", line_number: 1}) as never;

beforeEach(() => {
  jest.clearAllMocks();
  (getLatestPRCommentScan as jest.Mock).mockResolvedValue({scanId: "s9", commentId: 555, status: "complete"});
  (getOpenPRFindings as jest.Mock).mockResolvedValue([]);
  (getFindingRefs as jest.Mock).mockResolvedValue(new Map());
});

describe("refreshPRComment", () => {
  it("edits the existing comment with the findings still open on the PR", async () => {
    (getOpenPRFindings as jest.Mock).mockResolvedValue([finding("f1"), finding("f2", "c1")]);
    (getFindingRefs as jest.Mock).mockResolvedValue(
      new Map([["c1", {trigger_type: "pull_request", trigger_ref: "3"}]]),
    );

    await expect(refreshPRComment(target)).resolves.toBe(true);

    expect(getOpenPRFindings).toHaveBeenCalledWith("r1", 7);
    const args = (postPRReview as jest.Mock).mock.calls[0];
    expect(args.slice(0, 8)).toEqual(["acme/app", 7, [finding("f1"), finding("f2", "c1")], [], REFRESH_SUMMARY, "s9", 42, 555]);
    expect([...args[9]]).toEqual([["c1", "PR #3"]]);
  });

  it("doesn't list this PR's own superseded rows as tracked elsewhere", async () => {
    (getOpenPRFindings as jest.Mock).mockResolvedValue([finding("f1", "c1")]);
    (getFindingRefs as jest.Mock).mockResolvedValue(
      new Map([["c1", {trigger_type: "pull_request", trigger_ref: "7"}]]),
    );
    await refreshPRComment(target);
    expect([...(postPRReview as jest.Mock).mock.calls[0][9]]).toEqual([]);
  });

  it("leaves the comment alone when the PR has none, or a non-complete scan owns it", async () => {
    (getLatestPRCommentScan as jest.Mock).mockResolvedValueOnce(null);
    await expect(refreshPRComment(target)).resolves.toBe(false);

    (getLatestPRCommentScan as jest.Mock).mockResolvedValueOnce({scanId: "s9", commentId: 555, status: "skipped"});
    await expect(refreshPRComment(target)).resolves.toBe(false);

    expect(getOpenPRFindings).not.toHaveBeenCalled();
    expect(postPRReview).not.toHaveBeenCalled();
  });

  it("never posts an all-clear when the findings read fails", async () => {
    (getOpenPRFindings as jest.Mock).mockRejectedValue(new Error("db down"));
    await expect(refreshPRComment(target)).rejects.toThrow("db down");
    expect(postPRReview).not.toHaveBeenCalled();
  });
});
