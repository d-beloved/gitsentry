/**
 * Detection of automated PRs that carry no scannable application code
 * (dependency bumps, release/version PRs). Kept in one module so the
 * pull_request webhook and tests share the exact same logic.
 */

// Dependency-update bots only bump manifests/lockfiles — there is no application
// code to analyze, and feeding the model a near-empty diff produced hallucinated
// findings. Skip them on every plan. Manual `/gitsentry scan` still works.
const DEPENDENCY_BOT_LOGINS = new Set([
  "dependabot[bot]",
  "dependabot-preview[bot]",
  "renovate[bot]",
  "renovatebot",
  "snyk-bot",
  "pyup-bot",
  "greenkeeper[bot]",
]);

export function isDependencyBot(login: string | undefined): boolean {
  if (!login) return false;
  const l = login.toLowerCase();
  return (
    DEPENDENCY_BOT_LOGINS.has(l) ||
    l.startsWith("dependabot") ||
    l.startsWith("renovate")
  );
}

// Release automation tools running as their own GitHub App author PRs under
// these logins. But the same tools running as a GitHub Actions workflow with
// the default GITHUB_TOKEN author PRs as "github-actions[bot]" — the login
// check alone misses those, so we also match on head branch and title below.
const RELEASE_BOT_LOGINS = new Set([
  "release-please[bot]",
  "semantic-release-bot",
  "changesets-release[bot]",
]);

// Head branch names used by release automation. These are distinctive enough
// to be author-independent: no human names a branch "release-please--…" or
// "changeset-release/…".
const RELEASE_BRANCH_PATTERNS = [
  /^release-please--/, // release-please: "release-please--branches--main[--components--pkg]"
  /^release-please\//, // older release-please action: "release-please/branches/main"
  /^changeset-release\//, // changesets action: "changeset-release/main"
];

// PR titles used by release automation. Title matching is only trusted when
// the author is a bot account (e.g. github-actions[bot]) so a human PR titled
// "chore: release checklist page" is never skipped.
const RELEASE_TITLE_PATTERNS = [
  /^chore(\([^)]*\))?:\s*release\b/i, // release-please: "chore(main): release 1.2.3"
  /^version packages/i, // changesets default title
];

export interface ReleaseAutomationSignals {
  login?: string;
  /** pr.user.type === "Bot" — GitHub marks app-authored PRs, incl. github-actions[bot] */
  isBotAuthor?: boolean;
  headRef?: string;
  title?: string;
}

export function isReleaseAutomationPR({
  login,
  isBotAuthor,
  headRef,
  title,
}: ReleaseAutomationSignals): boolean {
  const l = login?.toLowerCase() ?? "";
  if (RELEASE_BOT_LOGINS.has(l) || l.startsWith("release-please")) return true;

  if (headRef && RELEASE_BRANCH_PATTERNS.some((p) => p.test(headRef))) {
    return true;
  }

  if (isBotAuthor && title && RELEASE_TITLE_PATTERNS.some((p) => p.test(title))) {
    return true;
  }

  return false;
}
