import { getDiff, getIncrementalDiff, postBotPRSkipComment, postSyncSkipComment, postSubscriptionPausedComment } from "../lib/github";
import { saveScan, updateScanStatus, getOrgByInstallationId, scanExistsForCommit, getLastPRScanResult } from "../db/queries";
import { parseDiffStats, truncateDiff, hasScannableContent } from "../lib/differ";
import { isDependencyBot, isReleaseAutomationPR } from "../lib/botDetection";
import { dispatchScan } from "../lib/queue";

// Starter plan: skip re-scan on synchronize if the last scan was clean and the
// incremental diff is below this line threshold (covers minor fixup commits).
const STARTER_CLEAN_RESCAN_THRESHOLD = 25;

// Subscription states that mean a paid plan has lapsed. Paddle downgrades plan
// to "free" on lapse, so an org whose plan is "free" *and* whose status is one
// of these was a paying customer whose access to private-repo scans just ended.
const LAPSED_SUBSCRIPTION_STATUSES = new Set(["canceled", "past_due", "payment_failed"]);

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

  // Release automation PRs (release-please, changesets, semantic-release) only
  // bump versions and update changelogs — skip on all plans. Detected by author
  // login, head branch, AND bot-authored release titles: when these tools run as
  // a GitHub Actions workflow, the PR author is "github-actions[bot]", so the
  // login check alone misses them.
  if (
    isReleaseAutomationPR({
      login: prLogin,
      isBotAuthor: isBot,
      headRef: prHead.ref as string | undefined,
      title: pr.title as string | undefined,
    })
  ) {
    console.log(
      `[PR] Skipping release automation PR ${repo.full_name}#${pr.number} (author: ${prLogin}, branch: ${prHead.ref})`,
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
    // A downgraded org (was paying, subscription lapsed) still expects its
    // private repos to be scanned. Instead of silently dropping the scan —
    // which made the dashboard look "clean" when nothing ran — record an
    // explicit skipped scan so the dashboard tells the truth, and (once, on
    // open/reopen) explain on the PR why scanning is paused.
    const lapsed = !!(org?.subscription_status && LAPSED_SUBSCRIPTION_STATUSES.has(org.subscription_status));
    if (lapsed) {
      try {
        const skippedScan = await saveScan({
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
          filesChanged: 0,
          linesAdded: 0,
        });
        await updateScanStatus(skippedScan.id, [], 0, "skipped", {
          failureReason: "subscription_inactive",
        });
      } catch (err) {
        console.error("[PR] failed to record subscription-paused skip:", (err as Error).message);
      }

      if (action !== "synchronize") {
        postSubscriptionPausedComment(
          repo.full_name as string,
          pr.number as number,
          installationId,
        ).catch((err: Error) => console.error("[PR] postSubscriptionPausedComment failed:", err.message));
      }
    }
    console.log(`[PR] Skipping private repo ${repo.full_name} — free/${org?.subscription_status ?? "no-sub"} plan`);
    return;
  }

  if (action === "synchronize" && (!org || org.plan === "free")) {
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

  let diff: string;
  if (action === "synchronize") {
    const beforeSha = payload.before as string | undefined;
    if (beforeSha) {
      try {
        diff = await getIncrementalDiff(
          repo.full_name as string,
          beforeSha,
          prHead.sha as string,
          installationId,
        );
      } catch {
        diff = await getDiff(repo.full_name as string, pr.number as number, installationId);
      }
    } else {
      diff = await getDiff(repo.full_name as string, pr.number as number, installationId);
    }

    // Starter only: skip when the incremental delta is tiny and the last scan was clean.
    if (org?.plan === "starter") {
      const {linesAdded} = parseDiffStats(diff);
      if (linesAdded < STARTER_CLEAN_RESCAN_THRESHOLD) {
        const lastScan = await getLastPRScanResult(
          repo.full_name as string,
          pr.number as number,
        );
        if (lastScan && lastScan.findingsCount === 0) {
          console.log(
            `[PR] Skipping small clean-PR update for ${repo.full_name}#${pr.number} — starter plan, ${linesAdded} lines added, last scan clean`,
          );
          postSyncSkipComment(
            repo.full_name as string,
            pr.number as number,
            linesAdded,
            installationId,
          ).catch((err: Error) => console.error("[PR] postSyncSkipComment failed:", err.message));
          return;
        }
      }
    }
  } else {
    diff = await getDiff(repo.full_name as string, pr.number as number, installationId);
  }

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
