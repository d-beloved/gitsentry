const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Counts findings by severity level.
 * @param {Array<{severity: string}>} issues
 */
function countBySeverity(issues) {
  return {
    critical: issues.filter((i) => i.severity === "critical").length,
    high: issues.filter((i) => i.severity === "high").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
  };
}

/**
 * Sorts findings most-severe first.
 * @param {Array<{severity: string}>} issues
 */
function sortBySeverity(issues) {
  return [...issues].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  );
}

/**
 * Returns true if any finding meets or exceeds the given minimum severity.
 * @param {Array<{severity: string}>} issues
 * @param {'critical'|'high'|'medium'|'low'} minSeverity
 */
function hasMinSeverity(issues, minSeverity) {
  const threshold = SEVERITY_ORDER[minSeverity] ?? 99;
  return issues.some((i) => (SEVERITY_ORDER[i.severity] ?? 99) <= threshold);
}

module.exports = { countBySeverity, sortBySeverity, hasMinSeverity };
