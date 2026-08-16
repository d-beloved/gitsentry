import {formatReviewBody} from "../github";
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

  // The regression itself: this body replaced a real HIGH on a live PR because
  // the scan that produced it had only read a six-line unrelated diff.
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
    // No section headers to explain when every finding came from this scan.
    expect(body).not.toContain("Introduced by the latest commits");
    expect(body).not.toContain("Still open from earlier commits");
  });
});
