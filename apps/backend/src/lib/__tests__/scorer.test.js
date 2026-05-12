const { countBySeverity, sortBySeverity, hasMinSeverity } = require("../scorer");

const MIXED_ISSUES = [
  { severity: "critical" },
  { severity: "high" },
  { severity: "high" },
  { severity: "medium" },
  { severity: "low" },
];

describe("countBySeverity", () => {
  test("counts each severity level correctly", () => {
    expect(countBySeverity(MIXED_ISSUES)).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      low: 1,
    });
  });

  test("returns all zeros for an empty array", () => {
    expect(countBySeverity([])).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });

  test("handles unknown severity values without throwing", () => {
    const result = countBySeverity([{ severity: "unknown" }]);
    expect(result).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });
});

describe("sortBySeverity", () => {
  test("sorts critical before high before medium before low", () => {
    const sorted = sortBySeverity([
      { severity: "low" },
      { severity: "critical" },
      { severity: "medium" },
      { severity: "high" },
    ]);
    expect(sorted.map((i) => i.severity)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });

  test("does not mutate the original array", () => {
    const original = [{ severity: "low" }, { severity: "critical" }];
    sortBySeverity(original);
    expect(original[0].severity).toBe("low");
  });

  test("returns an empty array unchanged", () => {
    expect(sortBySeverity([])).toEqual([]);
  });

  test("preserves order of equal-severity issues", () => {
    const issues = [
      { severity: "high", id: 1 },
      { severity: "high", id: 2 },
    ];
    const sorted = sortBySeverity(issues);
    expect(sorted[0].id).toBe(1);
    expect(sorted[1].id).toBe(2);
  });
});

describe("hasMinSeverity", () => {
  test("returns true when an issue meets the exact threshold", () => {
    expect(hasMinSeverity([{ severity: "high" }], "high")).toBe(true);
  });

  test("returns true when an issue exceeds the threshold (critical vs high)", () => {
    expect(hasMinSeverity([{ severity: "critical" }], "high")).toBe(true);
  });

  test("returns false when all issues are below the threshold", () => {
    expect(hasMinSeverity([{ severity: "low" }, { severity: "medium" }], "high")).toBe(false);
  });

  test("returns false for an empty array", () => {
    expect(hasMinSeverity([], "low")).toBe(false);
  });

  test("works correctly for the critical threshold", () => {
    expect(hasMinSeverity([{ severity: "high" }], "critical")).toBe(false);
    expect(hasMinSeverity([{ severity: "critical" }], "critical")).toBe(true);
  });
});
