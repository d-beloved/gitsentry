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
    // parse-diff can choke on unusual diffs — fall back to raw diff
    return diffText.slice(0, maxBytes);
  }

  const result = parts.join("\n");
  return result.length > maxBytes
    ? result.slice(0, maxBytes) + "\n[ADDITIONS TRUNCATED]"
    : result;
}
