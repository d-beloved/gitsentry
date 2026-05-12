const { parseDiffStats, truncateDiff } = require("../differ");

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

  test("uses the default 12000-byte limit when maxBytes is omitted", () => {
    const short = "x".repeat(100);
    expect(truncateDiff(short)).toBe(short);

    const long = "x".repeat(13000);
    expect(truncateDiff(long)).toContain("[diff truncated]");
  });
});
