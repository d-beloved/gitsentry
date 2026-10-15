// Recognises a finding already on record for the repo, so parallel PRs (or the merge to main)
// carrying the same change don't list the same issue again.

export interface DedupeIssue {
  category: string;
  file_path: string;
  line_number: number | null;
  code_snippet: string | null;
}

export interface DedupeCandidate extends DedupeIssue {
  id: string;
  is_false_positive: boolean;
  /** True when the candidate came from an earlier scan of the same PR or branch. */
  sameTrigger: boolean;
}

export type DedupeMatch =
  | {kind: "dismissed"; canonicalId: string}
  | {kind: "duplicate"; canonicalId: string}
  | {kind: "supersedes"; canonicalId: string};

// Below this, containment ("}" inside anything) says nothing about identity.
const MIN_CONTAINED_SNIPPET = 20;

export function normalizeSnippet(snippet: string | null | undefined): string {
  if (!snippet) return "";
  return snippet
    .split("\n")
    .map((line) => line.trim().replace(/^[+-](?=\s)/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

export function isSameIssue(a: DedupeIssue, b: DedupeIssue): boolean {
  if (a.category !== b.category || a.file_path !== b.file_path) return false;
  const sa = normalizeSnippet(a.code_snippet);
  const sb = normalizeSnippet(b.code_snippet);
  if (sa && sb) {
    if (sa === sb) return true;
    const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
    return short.length >= MIN_CONTAINED_SNIPPET && long.includes(short);
  }
  return a.line_number != null && a.line_number === b.line_number;
}

function nearest(issue: DedupeIssue, pool: DedupeCandidate[]): DedupeCandidate | undefined {
  const dist = (c: DedupeCandidate) =>
    issue.line_number != null && c.line_number != null
      ? Math.abs(issue.line_number - c.line_number)
      : Number.MAX_SAFE_INTEGER;
  return [...pool].sort((x, y) => dist(x) - dist(y))[0];
}

/**
 * A dismissal wins, so a triaged false positive stays quiet everywhere. An open finding from
 * another PR/branch makes this a duplicate. A re-report on the same PR supersedes the old row,
 * which the staleness pass then retires.
 */
export function matchExisting(
  issue: DedupeIssue,
  candidates: DedupeCandidate[],
): DedupeMatch | null {
  const same = candidates.filter((c) => isSameIssue(issue, c));
  if (!same.length) return null;

  const dismissed = nearest(issue, same.filter((c) => c.is_false_positive));
  if (dismissed) return {kind: "dismissed", canonicalId: dismissed.id};

  const elsewhere = nearest(issue, same.filter((c) => !c.sameTrigger));
  if (elsewhere) return {kind: "duplicate", canonicalId: elsewhere.id};

  const previous = nearest(issue, same);
  return previous ? {kind: "supersedes", canonicalId: previous.id} : null;
}
