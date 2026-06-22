import {
  parseDiffStats,
  truncateDiff,
  extractAdditions,
  extractScannablePaths,
  hasScannableContent,
} from "../differ";

const SINGLE_FILE_DIFF = `\
diff --git a/src/app.js b/src/app.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/app.js
@@ -0,0 +1,3 @@
+const express = require('express');
+const app = express();
+module.exports = app;
`;

const MULTI_FILE_DIFF = `\
diff --git a/src/app.js b/src/app.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/app.js
@@ -0,0 +1,2 @@
+const express = require('express');
+module.exports = express();
diff --git a/src/auth.js b/src/auth.js
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/src/auth.js
@@ -0,0 +1,1 @@
+module.exports = (req, res, next) => next();
`;

describe("parseDiffStats", () => {
  test("returns zero counts for empty string", () => {
    expect(parseDiffStats("")).toEqual({ filesChanged: 0, linesAdded: 0 });
  });

  test("returns zero counts for null/undefined", () => {
    expect(parseDiffStats(null)).toEqual({ filesChanged: 0, linesAdded: 0 });
    expect(parseDiffStats(undefined)).toEqual({ filesChanged: 0, linesAdded: 0 });
  });

  test("counts files and added lines for a single-file diff", () => {
    const { filesChanged, linesAdded } = parseDiffStats(SINGLE_FILE_DIFF);
    expect(filesChanged).toBe(1);
    expect(linesAdded).toBe(3);
  });

  test("counts files and added lines for a multi-file diff", () => {
    const { filesChanged, linesAdded } = parseDiffStats(MULTI_FILE_DIFF);
    expect(filesChanged).toBe(2);
    expect(linesAdded).toBe(3);
  });
});

const LOCK_FILE_DIFF = `\
diff --git a/package-lock.json b/package-lock.json
index 0000000..1234567
--- a/package-lock.json
+++ b/package-lock.json
@@ -0,0 +1,2 @@
+{
+  "lockfileVersion": 3
`;

const MIXED_DIFF = `\
diff --git a/src/app.js b/src/app.js
index 0000000..1234567
--- a/src/app.js
+++ b/src/app.js
@@ -1,2 +1,3 @@
 const express = require('express');
-const old = 1;
+const app = express();
+module.exports = app;
diff --git a/package-lock.json b/package-lock.json
index 0000000..abcdefg
--- a/package-lock.json
+++ b/package-lock.json
@@ -0,0 +1,1 @@
+{ "lockfileVersion": 3 }
`;

describe("extractAdditions", () => {
  test("returns empty string for empty input", () => {
    expect(extractAdditions("")).toBe("");
    expect(extractAdditions(null)).toBe("");
    expect(extractAdditions(undefined)).toBe("");
  });

  test("extracts only added lines with file headers and line numbers", () => {
    const result = extractAdditions(SINGLE_FILE_DIFF);
    expect(result).toContain("=== src/app.js ===");
    expect(result).toContain("L1: const express = require('express');");
    expect(result).toContain("L2: const app = express();");
    expect(result).toContain("L3: module.exports = app;");
  });

  test("omits removed lines", () => {
    const result = extractAdditions(MIXED_DIFF);
    expect(result).not.toContain("const old = 1");
  });

  test("omits context lines", () => {
    const result = extractAdditions(MIXED_DIFF);
    expect(result).not.toContain("const express = require");
  });

  test("skips lock files", () => {
    const result = extractAdditions(LOCK_FILE_DIFF);
    expect(result).toBe("");
  });

  test("skips lock files in a mixed diff but includes other files", () => {
    const result = extractAdditions(MIXED_DIFF);
    expect(result).toContain("=== src/app.js ===");
    expect(result).not.toContain("package-lock.json");
  });

  test("truncates output at maxBytes and appends marker", () => {
    const result = extractAdditions(MULTI_FILE_DIFF, 20);
    expect(result).toContain("[ADDITIONS TRUNCATED]");
  });
});

describe("extractScannablePaths", () => {
  test("returns [] for empty/null input", () => {
    expect(extractScannablePaths("")).toEqual([]);
    expect(extractScannablePaths(null)).toEqual([]);
    expect(extractScannablePaths(undefined)).toEqual([]);
  });

  test("returns the non-skipped file paths from the diff", () => {
    expect(extractScannablePaths(MULTI_FILE_DIFF).sort()).toEqual([
      "src/app.js",
      "src/auth.js",
    ]);
  });

  test("excludes lock files", () => {
    expect(extractScannablePaths(MIXED_DIFF)).toEqual(["src/app.js"]);
    expect(extractScannablePaths(LOCK_FILE_DIFF)).toEqual([]);
  });
});

describe("hasScannableContent", () => {
  test("false for empty/null input", () => {
    expect(hasScannableContent("")).toBe(false);
    expect(hasScannableContent(null)).toBe(false);
    expect(hasScannableContent(undefined)).toBe(false);
  });

  test("true when the diff has real code", () => {
    expect(hasScannableContent(SINGLE_FILE_DIFF)).toBe(true);
    expect(hasScannableContent(MIXED_DIFF)).toBe(true);
  });

  test("false for a lockfile-only diff", () => {
    expect(hasScannableContent(LOCK_FILE_DIFF)).toBe(false);
  });
});

describe("truncateDiff", () => {
  test("returns the diff unchanged when under the byte limit", () => {
    const diff = "short diff";
    expect(truncateDiff(diff, 1000)).toBe(diff);
  });

  test("returns the diff unchanged when exactly at the byte limit", () => {
    const diff = "x".repeat(100);
    expect(truncateDiff(diff, 100)).toBe(diff);
  });

  test("truncates and appends the truncation marker when over the limit", () => {
    const diff = "x".repeat(200);
    const result = truncateDiff(diff, 100);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result.endsWith("[diff truncated]")).toBe(true);
  });

  test("uses the default 200000-byte limit when maxBytes is omitted", () => {
    const short = "x".repeat(100);
    expect(truncateDiff(short)).toBe(short);

    const long = "x".repeat(201_000);
    expect(truncateDiff(long)).toContain("[diff truncated]");
  });
});
