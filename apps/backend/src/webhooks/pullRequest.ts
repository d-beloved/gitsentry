import { getDiff, getIncrementalDiff, postBotPRSkipComment, postSyncSkipComment, postSubscriptionPausedComment, postSkippedCheckRun, hasRequiredCheck, type SkippedScanReason } from "../lib/github";
import { saveScan, updateScanStatus, getOrgByInstallationId, scanExistsForCommit, getLastPRScanResult, getPreviousPRCommentId, updateScanCommentId, getRepoIdByFullName } from "../db/queries";
import { parseDiffStats, truncateDiff, hasScannableContent } from "../lib/differ";
import { isDependencyBot, isReleaseAutomationPR } from "../lib/botDetection";
import { dispatchScan } from "../lib/queue";

// Starter: skip a synchronize re-scan below this many added lines if the last scan was clean.
const STARTER_CLEAN_RESCAN_THRESHOLD = 25;

// Paddle sets plan:"free" on lapse; status tells a lapsed payer from a free org.
const LAPSED_SUBSCRIPTION_STATUSES = new Set(["canceled", "past_due", "payment_failed"]);

// Early returns create no scan row, so resolve any required check here or the
// PR waits forever. Gated on hasRequiredCheck so we never invent a check.
function releaseCheck(
  repoFullName: string,
  headSha: string,
  installationId: number,
  reason: SkippedScanReason,
  /** `undefined` = not fetched yet; `null` = no org record exists. */
  org: Awaited<ReturnType<typeof getOrgByInstallationId>> | undefined,
): void {
  void (async () => {
    try {
      const resolved = org === undefined ? await getOrgByInstallationId(installationId) : org;
      if (!hasRequiredCheck(resolved)) return;
      await postSkippedCheckRun(repoFullName, headSha, installationId, reason);
    } catch (err) {
      console.error(`[PR] postSkippedCheckRun(${reason}) failed:`, (err as Error).message);
    }
  })();
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

  const needsOrg = !!(repo.private) || action === "synchronize" || isBot;

  const [org, alreadyScanned] = await Promise.all([
    needsOrg ? getOrgByInstallationId(installationId) : Promise.resolve(null),
    scanExistsForCommit(repo.full_name as string, prHead.sha as string),
  ]);

  if (alreadyScanned) {
    console.log(`[PR] Skipping duplicate delivery for ${repo.full_name} commit ${prHead.sha}`);
    return;
  }

  // Bot skips run after the duplicate guard so a redelivery doesn't post a second check.
  if (isDependencyBot(prLogin)) {
    console.log(
      `[PR] Skipping dependency bot PR ${repo.full_name}#${pr.number} (author: ${prLogin})`,
    );
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "dependency_bot", needsOrg ? org : undefined);
    return;
  }

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
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "release_automation", needsOrg ? org : undefined);
    return;
  }


  if (repo.private && (!org || org.plan === "free")) {
    // Lapsed orgs get an explicit skipped scan so nothing reads as clean, plus
    // a PR comment on open/reopen.
    const lapsed = !!(org?.subscription_status && LAPSED_SUBSCRIPTION_STATUSES.has(org.subscription_status));
    if (lapsed) {
      let skippedScanId: string | null = null;
      let skippedScanRepoId: string | null = null;
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
        skippedScanId = skippedScan.id;
        skippedScanRepoId = skippedScan.repo_id;
        await updateScanStatus(skippedScan.id, [], 0, "skipped", {
          failureReason: "subscription_inactive",
        });
      } catch (err) {
        console.error("[PR] failed to record subscription-paused skip:", (err as Error).message);
      }

      if (action !== "synchronize") {
        (async () => {
          try {
            const existing = skippedScanRepoId
              ? await getPreviousPRCommentId(skippedScanRepoId, pr.number as number)
              : null;
            const commentId = await postSubscriptionPausedComment(
              repo.full_name as string,
              pr.number as number,
              installationId,
              existing?.commentId ?? null,
            );
            if (skippedScanId) await updateScanCommentId(skippedScanId, commentId);
          } catch (err) {
            console.error("[PR] postSubscriptionPausedComment failed:", (err as Error).message);
          }
        })();
      }
    }
    console.log(`[PR] Skipping private repo ${repo.full_name} — free/${org?.subscription_status ?? "no-sub"} plan`);
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "subscription_inactive", org);
    return;
  }

  if (action === "synchronize" && (!org || org.plan === "free")) {
    console.log(`[PR] Skipping synchronize for ${repo.full_name} — ${org?.plan ?? "free"} plan`);
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "subscription_inactive", org);
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
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "subscription_inactive", org);
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
          (async () => {
            try {
              const repoId = await getRepoIdByFullName(repo.full_name as string);
              const existing = repoId ? await getPreviousPRCommentId(repoId, pr.number as number) : null;
              await postSyncSkipComment(
                repo.full_name as string,
                pr.number as number,
                linesAdded,
                installationId,
                existing?.commentId ?? null,
              );
            } catch (err) {
              console.error("[PR] postSyncSkipComment failed:", (err as Error).message);
            }
          })();
          return;
        }
      }
    }
  } else {
    diff = await getDiff(repo.full_name as string, pr.number as number, installationId);
  }

  if (!diff || diff.length < 10) {
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "no_scannable_changes", needsOrg ? org : undefined);
    return;
  }

  // Empty scanner input invites hallucinated findings.
  if (!hasScannableContent(diff)) {
    console.log(
      `[PR] Skipping ${repo.full_name}#${pr.number} — no scannable code (dependency/generated-only diff)`,
    );
    releaseCheck(repo.full_name as string, prHead.sha as string, installationId, "no_scannable_changes", needsOrg ? org : undefined);
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
