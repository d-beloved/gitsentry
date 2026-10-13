// Dependency bots only touch manifests/lockfiles; a near-empty diff makes the
// model hallucinate findings, so skip them. Manual `/gitsentry scan` still works.
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

// Run via GITHUB_TOKEN these tools author as "github-actions[bot]", so the
// login check alone misses them; branch and title are matched too.
const RELEASE_BOT_LOGINS = new Set([
  "release-please[bot]",
  "semantic-release-bot",
  "changesets-release[bot]",
]);

// Distinctive enough to match regardless of author.
const RELEASE_BRANCH_PATTERNS = [
  /^release-please--/, // release-please: "release-please--branches--main[--components--pkg]"
  /^release-please\//, // older release-please action: "release-please/branches/main"
  /^changeset-release\//, // changesets action: "changeset-release/main"
];

// Only trusted for bot authors, so a human "chore: release ..." PR is never skipped.
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
