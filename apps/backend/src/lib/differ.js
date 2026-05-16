const parseDiff = require("parse-diff");
const {MAX_DIFF_BYTES} = require("../../../../packages/scanner-contract/constants");

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

module.exports = { parseDiffStats, truncateDiff };
