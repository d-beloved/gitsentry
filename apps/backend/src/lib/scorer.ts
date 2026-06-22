import { SEVERITY_ORDER } from "../../../../packages/scanner-contract/constants";
import type { Severity } from "../../../../packages/scanner-contract/types";

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export function countBySeverity(issues: Array<{ severity: string }>): SeverityCounts {
  return {
    critical: issues.filter((i) => i.severity === "critical").length,
    high: issues.filter((i) => i.severity === "high").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
  };
}

export function sortBySeverity<T extends { severity: string }>(issues: T[]): T[] {
  return [...issues].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity as Severity] ?? 99) -
      (SEVERITY_ORDER[b.severity as Severity] ?? 99),
  );
}
