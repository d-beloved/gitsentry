const parseDiff = require("parse-diff");
const {MAX_DIFF_BYTES} = require("../../../../packages/scanner-contract/constants");

const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /poetry\.lock$/,
  /Cargo\.lock$/,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /\.snap$/,
];

/**
 * Extracts file-level stats from a raw git diff.
 * @param {string} diffText
 * @returns {{ filesChanged: number, linesAdded: number }}
 */
function parseDiffStats(diffText) {
  if (!diffText) return { filesChanged: 0, linesAdded: 0 };

  let filesChanged = 0;
  let linesAdded = 0;

  try {
    const files = parseDiff(diffText);
    for (const file of files) {
      filesChanged++;
      for (const chunk of file.chunks) {
        for (const change of chunk.changes) {
          if (change.type === "add") linesAdded++;
        }
      }
    }
  } catch {
    // parse-diff can choke on unusual diffs — degrade gracefully
  }

  return { filesChanged, linesAdded };
}

/**
 * Truncates a diff to a safe byte size for the AI prompt.
 * Post-MVP: replace with smart per-file chunking.
 * @param {string} diffText
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateDiff(diffText, maxBytes = MAX_DIFF_BYTES) {
  if (diffText.length <= maxBytes) return diffText;
  return diffText.slice(0, maxBytes) + "\n\n[diff truncated]";
}

/**
 * Extracts only added lines from a diff, grouped by file, skipping lock files
 * and minified assets. Returns a compact string suitable for AI analysis.
 *
 * Format per file:
 *   === path/to/file.js ===
 *   L<num>: <code>
 *
 * @param {string} diffText
 * @param {number} [maxBytes]
 * @returns {string}
 */
function extractAdditions(diffText, maxBytes = MAX_DIFF_BYTES) {
  if (!diffText) return "";

  const parts = [];
  try {
    const files = parseDiff(diffText);
    for (const file of files) {
      const filePath = file.to ?? file.from ?? "unknown";
      if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;

      const added = [];
      for (const chunk of file.chunks) {
        for (const change of chunk.changes) {
          if (change.type === "add") {
            added.push(`L${change.ln}: ${change.content.slice(1)}`);
          }
        }
      }
      if (added.length === 0) continue;

      parts.push(`=== ${filePath} ===`);
      parts.push(...added);
    }
  } catch {
    // parse-diff can choke on unusual diffs — fall back to raw diff
    return diffText.slice(0, maxBytes);
  }

  const result = parts.join("\n");
  return result.length > maxBytes
    ? result.slice(0, maxBytes) + "\n[ADDITIONS TRUNCATED]"
    : result;
}

module.exports = { parseDiffStats, truncateDiff, extractAdditions };
