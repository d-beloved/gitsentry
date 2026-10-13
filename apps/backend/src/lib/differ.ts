import parseDiff from "parse-diff";
import { MAX_DIFF_BYTES } from "../../../../packages/scanner-contract/constants";
import type { ScanCoverage } from "../../../../packages/scanner-contract/types";

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

// Degraded first under budget pressure. Config (json/yaml/env) is deliberately
// excluded: config files are a prime home for secrets.
const LOW_RISK_FILE_PATTERNS = [
  /\.(md|mdx|txt|rst|adoc)$/i,
  /\.(css|scss|less|styl)$/i,
  /\.(svg|png|jpe?g|gif|ico|webp|woff2?)$/i,
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
    // parse-diff can choke on unusual diffs.
  }

  return { filesChanged, linesAdded };
}

export function truncateDiff(diffText: string, maxBytes: number = MAX_DIFF_BYTES): string {
  if (diffText.length <= maxBytes) return diffText;
  return diffText.slice(0, maxBytes) + "\n\n[diff truncated]";
}

interface FileBlock {
  path: string;
  lowRisk: boolean;
  full: string;
  /** Added + removed lines only, no context. */
  compact: string;
}

function isLowRisk(path: string): boolean {
  return LOW_RISK_FILE_PATTERNS.some((p) => p.test(path));
}

function buildFileBlocks(diffText: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  const files = parseDiff(diffText);

  for (const file of files) {
    const filePath = file.to ?? file.from ?? "unknown";
    if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;

    const hasChanges = file.chunks.some((chunk) =>
      chunk.changes.some((c) => c.type === "add" || c.type === "del"),
    );
    if (!hasChanges) continue;

    const full: string[] = [`=== ${filePath} ===`];
    const compact: string[] = [`=== ${filePath} ===`];

    for (const chunk of file.chunks) {
      full.push(chunk.content); // @@ hunk header
      compact.push(chunk.content);
      for (const change of chunk.changes) {
        if (change.type === "add") {
          const line = `+ L${change.ln}: ${change.content.slice(1)}`;
          full.push(line);
          compact.push(line);
        } else if (change.type === "del") {
          // Old line number: lets the model flag deleted security controls.
          const line = `- (was L${change.ln}): ${change.content.slice(1)}`;
          full.push(line);
          compact.push(line);
        } else if (change.type === "normal") {
          // ln2 = line number in the new file.
          const ln = (change as { ln2?: number; ln1?: number }).ln2 ?? (change as { ln1?: number }).ln1 ?? "";
          full.push(`  L${ln}: ${change.content.slice(1)}`);
        }
      }
    }

    blocks.push({
      path: filePath,
      lowRisk: isLowRisk(filePath),
      full: full.join("\n"),
      compact: compact.join("\n"),
    });
  }

  return blocks;
}

export interface ExtractedDiff {
  text: string;
  coverage: ScanCoverage;
}

/** Over budget, degrades by priority instead of slicing bytes; dropped files are named and reported. */
export function extractScannerInput(
  diffText: string | null | undefined,
  maxBytes: number = MAX_DIFF_BYTES,
): ExtractedDiff {
  const emptyCoverage: ScanCoverage = { filesTotal: 0, filesScanned: 0, truncated: false };
  if (!diffText) return { text: "", coverage: emptyCoverage };

  let blocks: FileBlock[];
  try {
    blocks = buildFileBlocks(diffText);
  } catch {
    // parse-diff can choke on unusual diffs; fall back to the raw diff.
    return {
      text: diffText.slice(0, maxBytes),
      coverage: { filesTotal: 0, filesScanned: 0, truncated: diffText.length > maxBytes },
    };
  }

  const filesTotal = blocks.length;
  const size = (parts: string[]) => parts.join("\n\n").length;

  // 1. Everything with full context.
  let rendered = blocks.map((b) => b.full);
  if (size(rendered) <= maxBytes) {
    return {
      text: rendered.join("\n\n"),
      coverage: { filesTotal, filesScanned: filesTotal, truncated: false },
    };
  }

  // 2. Low-risk files lose their context lines.
  rendered = blocks.map((b) => (b.lowRisk ? b.compact : b.full));
  if (size(rendered) <= maxBytes) {
    return {
      text: rendered.join("\n\n"),
      coverage: { filesTotal, filesScanned: filesTotal, truncated: true },
    };
  }

  // 3. Drop low-risk files entirely.
  const codeBlocks = blocks.filter((b) => !b.lowRisk);
  const droppedLowRisk = blocks.filter((b) => b.lowRisk).map((b) => b.path);
  rendered = codeBlocks.map((b) => b.full);
  if (size(rendered) <= maxBytes) {
    return {
      text: withDroppedNote(rendered, droppedLowRisk),
      coverage: { filesTotal, filesScanned: codeBlocks.length, truncated: true },
    };
  }

  // 4. All remaining files lose context lines.
  rendered = codeBlocks.map((b) => b.compact);
  if (size(rendered) <= maxBytes) {
    return {
      text: withDroppedNote(rendered, droppedLowRisk),
      coverage: { filesTotal, filesScanned: codeBlocks.length, truncated: true },
    };
  }

  // 5. Include compact files in diff order until the budget runs out.
  const included: string[] = [];
  const droppedPaths = [...droppedLowRisk];
  let used = 0;
  let includedCount = 0;
  for (const block of codeBlocks) {
    const cost = block.compact.length + 2; // + separator
    if (used + cost > maxBytes && includedCount > 0) {
      droppedPaths.push(block.path);
      continue;
    }
    // Always include at least one file, hard-sliced if it alone exceeds the budget.
    included.push(
      block.compact.length > maxBytes ? block.compact.slice(0, maxBytes) : block.compact,
    );
    used += cost;
    includedCount++;
  }

  return {
    text: withDroppedNote(included, droppedPaths),
    coverage: { filesTotal, filesScanned: includedCount, truncated: true },
  };
}

function withDroppedNote(rendered: string[], droppedPaths: string[]): string {
  if (!droppedPaths.length) return rendered.join("\n\n");
  const shown = droppedPaths.slice(0, 30);
  const more = droppedPaths.length - shown.length;
  return (
    rendered.join("\n\n") +
    `\n\n[NOT SCANNED — diff exceeded size budget: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}]` +
    `\n[Do not report findings for the unscanned files.]`
  );
}

export function extractWithContext(
  diffText: string | null | undefined,
  maxBytes: number = MAX_DIFF_BYTES,
): string {
  return extractScannerInput(diffText, maxBytes).text;
}

/** Paths the scanner sees. [] means "could not determine": callers must fail open. */
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
      const hasChanges = file.chunks.some((chunk) =>
        chunk.changes.some((c) => c.type === "add" || c.type === "del"),
      );
      if (!hasChanges) continue;
      paths.push(filePath);
    }
  } catch {
    return [];
  }

  return [...new Set(paths)];
}

/** Deletion-only changes count as scannable; fails open when parsing fails or no files are listed. */
export function hasScannableContent(diffText: string | null | undefined): boolean {
  if (!diffText) return false;

  try {
    const files = parseDiff(diffText);
    let sawAnyFile = false;
    for (const file of files) {
      sawAnyFile = true;
      const filePath = file.to ?? file.from ?? "unknown";
      if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;
      if (file.chunks.some((c) => c.changes.some((ch) => ch.type === "add" || ch.type === "del"))) {
        return true;
      }
    }
    return !sawAnyFile;
  } catch {
    return true;
  }
}
