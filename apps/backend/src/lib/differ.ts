import parseDiff from "parse-diff";
import { MAX_DIFF_BYTES } from "../../../../packages/scanner-contract/constants";

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

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
}

export function parseDiffStats(diffText: string | null | undefined): DiffStats {
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

export function truncateDiff(diffText: string, maxBytes: number = MAX_DIFF_BYTES): string {
  if (diffText.length <= maxBytes) return diffText;
  return diffText.slice(0, maxBytes) + "\n\n[diff truncated]";
}

/**
 * Extracts added lines plus surrounding unchanged context lines from a diff.
 * Sending context lines lets the AI see auth checks, middleware, and guards
 * that appear near (but not inside) the changed hunk, which reduces false
 * positives for patterns like fetch-then-ownership-check.
 *
 * Format:
 *   + L24: <added line>
 *     L22: <unchanged context line>
 */
export function extractWithContext(
  diffText: string | null | undefined,
  maxBytes: number = MAX_DIFF_BYTES,
): string {
  if (!diffText) return "";

  const parts: string[] = [];
  try {
    const files = parseDiff(diffText);
    for (const file of files) {
      const filePath = file.to ?? file.from ?? "unknown";
      if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;

      const hasAdditions = file.chunks.some((chunk) =>
        chunk.changes.some((c) => c.type === "add"),
      );
      if (!hasAdditions) continue;

      parts.push(`=== ${filePath} ===`);
      for (const chunk of file.chunks) {
        parts.push(chunk.content); // @@ hunk header
        for (const change of chunk.changes) {
          if (change.type === "add") {
            parts.push(`+ L${change.ln}: ${change.content.slice(1)}`);
          } else if (change.type === "normal") {
            // ln2 = line number in the new file for unchanged context lines
            const ln = (change as { ln2?: number; ln1?: number }).ln2 ?? (change as { ln1?: number }).ln1 ?? "";
            parts.push(`  L${ln}: ${change.content.slice(1)}`);
          }
          // deletions omitted — gone from the new file
        }
      }
    }
  } catch {
    // parse-diff can choke on unusual diffs — fall back to raw diff
    return diffText.slice(0, maxBytes);
  }

  const result = parts.join("\n");
  return result.length > maxBytes
    ? result.slice(0, maxBytes) + "\n[DIFF TRUNCATED]"
    : result;
}

/**
 * Returns the file paths the scanner actually sees — non-skipped files that
 * contain at least one added line (the same selection extractWithContext emits).
 * Used to validate that AI findings reference a file present in the scanned diff,
 * which guards against the model hallucinating findings for files not in the PR.
 *
 * Returns [] when the diff is empty or parse-diff fails. Callers must treat an
 * empty result as "could not determine" and fail open (do not suppress findings).
 */
export function extractScannablePaths(
  diffText: string | null | undefined,
): string[] {
  if (!diffText) return [];

  const paths: string[] = [];
  try {
    const files = parseDiff(diffText);
    for (const file of files) {
      const filePath = file.to ?? file.from ?? "unknown";
      if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;
      const hasAdditions = file.chunks.some((chunk) =>
        chunk.changes.some((c) => c.type === "add"),
      );
      if (!hasAdditions) continue;
      paths.push(filePath);
    }
  } catch {
    return [];
  }

  return [...new Set(paths)];
}

/**
 * True when the diff contains at least one file worth scanning after stripping
 * lockfiles, minified bundles, and other generated artifacts (SKIP_FILE_PATTERNS).
 * A lockfile/generated-only PR yields empty scanner input, which the AI tends to
 * fill with hallucinated findings — skip those scans entirely.
 *
 * Fails open: returns true when parse-diff chokes (extractWithContext falls back
 * to the raw diff in that case) or when the diff lists no files at all.
 */
export function hasScannableContent(diffText: string | null | undefined): boolean {
  if (!diffText) return false;

  try {
    const files = parseDiff(diffText);
    let sawAnyFile = false;
    for (const file of files) {
      sawAnyFile = true;
      const filePath = file.to ?? file.from ?? "unknown";
      if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;
      if (file.chunks.some((c) => c.changes.some((ch) => ch.type === "add"))) {
        return true;
      }
    }
    // Parsed cleanly: files present but all skipped → nothing to scan.
    // No files at all is unusual — fail open rather than silently drop.
    return !sawAnyFile;
  } catch {
    return true;
  }
}

/** @deprecated Use extractWithContext instead — this loses surrounding auth checks. */
export function extractAdditions(
  diffText: string | null | undefined,
  maxBytes: number = MAX_DIFF_BYTES,
): string {
  if (!diffText) return "";

  const parts: string[] = [];
  try {
    const files = parseDiff(diffText);
    for (const file of files) {
      const filePath = file.to ?? file.from ?? "unknown";
      if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;

      const added: string[] = [];
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
    return diffText.slice(0, maxBytes);
  }

  const result = parts.join("\n");
  return result.length > maxBytes
    ? result.slice(0, maxBytes) + "\n[ADDITIONS TRUNCATED]"
    : result;
}
