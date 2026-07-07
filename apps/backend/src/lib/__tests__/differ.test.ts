import {
  parseDiffStats,
  truncateDiff,
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

// ─── extractScannerInput ─────────────────────────────────────────────────────

import { extractScannerInput, extractWithContext } from "../differ";

const DELETION_DIFF = `\
diff --git a/src/middleware.js b/src/middleware.js
index 1234567..89abcde 100644
--- a/src/middleware.js
+++ b/src/middleware.js
@@ -1,4 +1,3 @@
 const router = require('./router');
-router.use(requireAuth);
 router.get('/users', listUsers);
 module.exports = router;
`;

const MIXED_CODE_DOCS_DIFF = `\
diff --git a/src/api.js b/src/api.js
index 1234567..89abcde 100644
--- a/src/api.js
+++ b/src/api.js
@@ -1,3 +1,3 @@
 const db = require('./db');
-const q = db.prepare('SELECT * FROM users WHERE id = ?');
+const q = 'SELECT * FROM users WHERE id = ' + req.params.id;
 module.exports = q;
diff --git a/README.md b/README.md
index 1234567..89abcde 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # App
+Some docs here.
`;

describe("extractScannerInput", () => {
  it("includes removed lines labelled with their old line number", () => {
    const { text, coverage } = extractScannerInput(DELETION_DIFF);
    expect(text).toContain("- (was L2): router.use(requireAuth);");
    expect(coverage).toEqual({ filesTotal: 1, filesScanned: 1, truncated: false });
  });

  it("treats deletion-only files as scannable", () => {
    const { coverage } = extractScannerInput(DELETION_DIFF);
    expect(coverage.filesTotal).toBe(1);
  });

  it("keeps added, removed, and context lines under normal budget", () => {
    const { text } = extractScannerInput(MIXED_CODE_DOCS_DIFF);
    expect(text).toContain("+ L2: const q = 'SELECT * FROM users WHERE id = ' + req.params.id;");
    expect(text).toContain("- (was L2): const q = db.prepare('SELECT * FROM users WHERE id = ?');");
    expect(text).toContain("  L1: const db = require('./db');");
  });

  it("drops low-risk files before code files under budget pressure", () => {
    // Budget fits the code file but not code + README with context.
    const codeOnly = extractScannerInput(MIXED_CODE_DOCS_DIFF, 250);
    expect(codeOnly.text).toContain("src/api.js");
    expect(codeOnly.text).not.toContain("Some docs here.");
    expect(codeOnly.text).toContain("[NOT SCANNED");
    expect(codeOnly.coverage.truncated).toBe(true);
    expect(codeOnly.coverage.filesScanned).toBeLessThan(codeOnly.coverage.filesTotal);
  });

  it("never returns zero files when a single file exceeds the budget", () => {
    const { text, coverage } = extractScannerInput(MIXED_CODE_DOCS_DIFF, 80);
    expect(coverage.filesScanned).toBeGreaterThanOrEqual(1);
    expect(text.length).toBeGreaterThan(0);
  });

  it("reports full coverage when nothing is truncated", () => {
    const { coverage } = extractScannerInput(MIXED_CODE_DOCS_DIFF);
    expect(coverage).toEqual({ filesTotal: 2, filesScanned: 2, truncated: false });
  });
});

describe("extractWithContext (back-compat wrapper)", () => {
  it("returns the same text as extractScannerInput", () => {
    expect(extractWithContext(MIXED_CODE_DOCS_DIFF)).toBe(extractScannerInput(MIXED_CODE_DOCS_DIFF).text);
  });
});

describe("deletion-aware scannable checks", () => {
  it("hasScannableContent is true for deletion-only diffs", () => {
    const { hasScannableContent } = require("../differ");
    expect(hasScannableContent(DELETION_DIFF)).toBe(true);
  });

  it("extractScannablePaths includes deletion-only files", () => {
    const { extractScannablePaths } = require("../differ");
    expect(extractScannablePaths(DELETION_DIFF)).toContain("src/middleware.js");
  });
});
