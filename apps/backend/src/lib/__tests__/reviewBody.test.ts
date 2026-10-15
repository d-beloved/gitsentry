import {codeSpan, formatReviewBody} from "../github";
import type {Finding} from "../../../../../packages/scanner-contract/types";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "high",
  category: "missing_auth",
  file_path: "api/rebuild.ts",
  line_number: 28,
  code_snippet: null,
  description: "Unauthenticated rebuild trigger",
  fix_suggestion: "Require the shared secret",
  ...over,
});

const CLEAN = "**No security issues found**";

describe("formatReviewBody", () => {
  it("reports clean only when nothing is open", () => {
    const body = formatReviewBody([], [], "all good", "scan-abc12345");
    expect(body).toContain(CLEAN);
  });

  // An incremental scan of an unrelated diff must not hide earlier open findings.
  it("never claims clean while a finding is carried over", () => {
    const body = formatReviewBody([], [finding()], "latest commits are clean", "scan-abc12345", true);

    expect(body).not.toContain(CLEAN);
    expect(body).toContain("Found **1 issue** in this PR");
    expect(body).toContain("Still open from earlier commits");
    expect(body).toContain("api/rebuild.ts");
  });

  it("counts new and carried findings together", () => {
    const body = formatReviewBody(
      [finding({severity: "medium", category: "idor", file_path: "src/new.ts"})],
      [finding()],
      "summary",
      "scan-abc12345",
      true,
    );

    expect(body).toContain("Found **2 issues** in this PR (1 high, 1 medium)");
    expect(body).toContain("Introduced by the latest commits");
    expect(body).toContain("Still open from earlier commits");
  });

  it("reads exactly as before when there is nothing carried", () => {
    const body = formatReviewBody([finding()], [], "summary", "scan-abc12345");

    expect(body).toContain("Found **1 issue** in this PR (1 high)");
    expect(body).not.toContain("Introduced by the latest commits");
    expect(body).not.toContain("Still open from earlier commits");
  });

  describe("issues already flagged on another PR", () => {
    const tracked = new Map([["canon-1", "PR #12"]]);
    const dupe = finding({duplicate_of: "canon-1", file_path: "src/db.ts", line_number: 42});

    it("folds them into one line each instead of a full write-up", () => {
      const body = formatReviewBody([finding(), dupe], [], "summary", "scan-abc12345", false, undefined, tracked);

      expect(body).toContain("Found **1 issue** in this PR (1 high)");
      expect(body).toContain("<summary>1 issue already flagged in PR #12</summary>");
      expect(body).toContain("`src/db.ts:42` · see PR #12");
      expect(body.match(/^### /gm)).toHaveLength(1);
    });

    it("never reads as clean when the only issues are tracked elsewhere", () => {
      const body = formatReviewBody([dupe], [], "summary", "scan-abc12345", false, undefined, tracked);

      expect(body).not.toContain(CLEAN);
      expect(body).toContain("**No new security issues** in this PR.");
      expect(body).toContain("already flagged in PR #12");
    });

    it("writes a duplicate up in full when its listed copy is not on another PR", () => {
      const body = formatReviewBody([dupe], [], "summary", "scan-abc12345", false, undefined, new Map());

      expect(body).toContain("Found **1 issue** in this PR");
      expect(body).not.toContain("<details>");
    });

    it("keeps hostile file paths and categories from breaking out of the line", () => {
      const evil = finding({duplicate_of: "canon-1", file_path: "a`<img src=x>`.ts", category: "<b>x</b>" as Finding["category"]});
      const body = formatReviewBody([evil], [], "summary", "scan-abc12345", false, undefined, tracked);

      expect(body).toContain("bxb in `aimg src=x.ts:28` · see PR #12");
      expect(body).not.toContain("<img");
    });
  });
});

describe("codeSpan", () => {
  it("strips backticks, angle brackets and newlines from a branch name", () => {
    expect(codeSpan("feat/`<img src=x>`\nmore")).toBe("`feat/img src=xmore`");
  });
});
