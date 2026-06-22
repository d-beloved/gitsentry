import { getDiff, postBotPRSkipComment } from "../lib/github";
import { saveScan, getOrgByInstallationId, scanExistsForCommit } from "../db/queries";
import { parseDiffStats, truncateDiff, hasScannableContent } from "../lib/differ";
import { dispatchScan } from "../lib/queue";

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

function isDependencyBot(login: string | undefined): boolean {
  if (!login) return false;
  const l = login.toLowerCase();
  return (
    DEPENDENCY_BOT_LOGINS.has(l) ||
    l.startsWith("dependabot") ||
    l.startsWith("renovate")
  );
}

export async function handlePR(payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const installation = payload.installation as Record<string, unknown> | undefined;

  if (!["opened", "synchronize", "reopened"].includes(action)) return;

  const installationId = installation?.id as number | undefined;
  if (!installationId) {
    console.warn("[PR] Missing installation.id — is this a GitHub App webhook?");
    return;
  }

  const prUser = pr.user as Record<string, unknown>;
  const prHead = pr.head as Record<string, unknown>;
  const repoOwner = repo.owner as Record<string, unknown>;
  const prLogin = prUser.login as string | undefined;
  const isBot = (prUser.type as string | undefined)?.toLowerCase() === "bot";

  // Dependency-update bots are skipped on all plans (no code to scan).
  if (isDependencyBot(prLogin)) {
    console.log(
      `[PR] Skipping dependency bot PR ${repo.full_name}#${pr.number} (author: ${prLogin})`,
    );
    return;
  }

  // Only fetch org when a plan check is actually needed.
  const needsOrg = !!(repo.private) || action === "synchronize" || isBot;

  const [org, alreadyScanned] = await Promise.all([
    needsOrg ? getOrgByInstallationId(installationId) : Promise.resolve(null),
    scanExistsForCommit(repo.full_name as string, prHead.sha as string),
  ]);

  if (alreadyScanned) {
    console.log(`[PR] Skipping duplicate delivery for ${repo.full_name} commit ${prHead.sha}`);
    return;
  }

  if (repo.private && (!org || org.plan === "free")) {
    console.log(`[PR] Skipping private repo ${repo.full_name} — free plan`);
    return;
  }

  if (action === "synchronize" && (!org || org.plan !== "pro")) {
    console.log(`[PR] Skipping synchronize for ${repo.full_name} — ${org?.plan ?? "free"} plan`);
    return;
  }

  if (isBot && (!org || org.plan === "free")) {
    if (action === "opened") {
      postBotPRSkipComment(
        repo.full_name as string,
        pr.number as number,
        prUser.login as string,
        installationId,
      ).catch((err: Error) => console.error("[PR] postBotPRSkipComment failed:", err.message));
    }
    console.log(`[PR] Skipping bot PR ${repo.full_name}#${pr.number} — free plan`);
    return;
  }

  const diff = await getDiff(repo.full_name as string, pr.number as number, installationId);
  if (!diff || diff.length < 10) return;

  // Skip lockfile/generated-only diffs — there is nothing scannable left after
  // stripping them, and an empty scanner input invites hallucinated findings.
  if (!hasScannableContent(diff)) {
    console.log(
      `[PR] Skipping ${repo.full_name}#${pr.number} — no scannable code (dependency/generated-only diff)`,
    );
    return;
  }

  const { filesChanged, linesAdded } = parseDiffStats(diff);

  const scan = await saveScan({
    repoFullName: repo.full_name as string,
    repoGithubId: repo.id as number,
    repoOwner: {
      githubId: repoOwner.id as number,
      login: repoOwner.login as string,
      avatarUrl: repoOwner.avatar_url as string | null,
    },
    installationId,
    isPrivate: (repo.private as boolean) ?? false,
    triggerType: "pull_request",
    triggerRef: String(pr.number),
    commitSha: prHead.sha as string,
    author: prUser.login as string,
    filesChanged,
    linesAdded,
  });

  const jobData = {
    scanId: scan.id,
    repoId: scan.repo_id,
    repoFullName: repo.full_name as string,
    diff: truncateDiff(diff),
    context: {
      repo: repo.full_name as string,
      branch: prHead.ref as string,
      triggerType: "pull_request" as const,
      author: prUser.login as string,
    },
    installationId,
    prNumber: pr.number as number,
    commitSha: prHead.sha as string,
    branch: prHead.ref as string,
    triggerType: "pull_request",
  };

  dispatchScan(jobData, `PR ${repo.full_name}#${pr.number}`);
}
