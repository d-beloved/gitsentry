import { discoverSecurityContext, classifyProject } from "./ai";
import { fetchRepoAuthFiles, fetchRepoManifestFiles, isAuthRelevantPath } from "./github";
import {
  getRepoSecurityContext,
  saveRepoSecurityContext,
  recordAiUsage,
  getFalsePositivePatterns,
} from "../db/queries";
import { extractPathsFromDiff } from "../../../../packages/scanner-contract/classifier";
import type { ProjectClassification } from "../../../../packages/scanner-contract/scanner-rules";

const DEFAULT_TTL_DAYS = 90;

function getTtlDays(): number {
  const raw = process.env.DISCOVERY_CACHE_TTL_DAYS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

function isStale(updatedAt: string | null, ttlDays: number): boolean {
  // Never trust an undated cache indefinitely.
  if (!updatedAt) return true;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}

function touchesAuthFiles(diffPaths: string[]): boolean {
  return diffPaths.some((p) => isAuthRelevantPath(p));
}

// Queried fresh every call: dismissals shouldn't wait on the discovery TTL.
async function withFalsePositiveNotes(repoId: string, context: string): Promise<string> {
  const patterns = await getFalsePositivePatterns(repoId).catch((err: Error) => {
    console.error("[securityContext] getFalsePositivePatterns failed:", err.message);
    return [];
  });
  if (!patterns.length) return context;

  const lines = patterns.map(
    (p) => `- Learned false positive: "${p.category}" findings have been dismissed as false positives ${p.count}x in this repo.`,
  );
  return context ? `${context}\n${lines.join("\n")}` : lines.join("\n");
}

export interface ResolvedSecurityContext {
  repoSecurityContext: string;
  classification?: ProjectClassification;
}

/** Cached discovery (refreshed when missing, auth files touched, or past TTL) plus a fresh classification. */
export async function resolveSecurityContext(params: {
  repoId: string;
  repoFullName: string;
  branch: string;
  installationId: number;
  diff: string;
  scanId: string | null;
}): Promise<ResolvedSecurityContext> {
  const { repoId, repoFullName, branch, installationId, diff, scanId } = params;
  const diffPaths = extractPathsFromDiff(diff);
  const cached = await getRepoSecurityContext(repoId);
  const ttlDays = getTtlDays();

  const needsRefresh = !cached || touchesAuthFiles(diffPaths) || isStale(cached.updatedAt, ttlDays);

  if (!needsRefresh && cached) {
    const classifyResult = await classifyProject(diffPaths, repoFullName).catch(() => undefined);
    if (classifyResult) {
      recordAiUsage({
        surface: "classifier",
        model: classifyResult.model,
        tokensIn: classifyResult.tokensIn,
        tokensOut: classifyResult.tokensOut,
        scanId,
        repoId,
      }).catch((err: Error) => console.error("[securityContext] recordAiUsage(classifier) failed:", err.message));
    }
    return {
      repoSecurityContext: await withFalsePositiveNotes(repoId, cached.context),
      classification: classifyResult?.classification,
    };
  }

  const reason = !cached ? "no cache yet" : touchesAuthFiles(diffPaths) ? "auth file touched" : `TTL expired (>${ttlDays}d)`;
  console.log(`[securityContext] Refreshing discovery for ${repoFullName} — ${reason}`);

  try {
    const [authFiles, manifestContent] = await Promise.all([
      fetchRepoAuthFiles(repoFullName, branch, installationId),
      fetchRepoManifestFiles(repoFullName, branch, installationId),
    ]);

    const allPaths = [...new Set([...diffPaths, ...authFiles.map((f) => f.path)])];

    const [discoveryResult, classifyResult] = await Promise.all([
      authFiles.length > 0 || manifestContent
        ? discoverSecurityContext(authFiles, repoFullName, manifestContent ?? undefined)
        : Promise.resolve(null),
      classifyProject(allPaths, repoFullName, manifestContent ?? undefined),
    ]);

    // Keep the last known-good context rather than wiping it on a transient miss.
    const repoSecurityContext = discoveryResult?.context ?? cached?.context ?? "";

    if (discoveryResult) {
      recordAiUsage({
        surface: "discovery",
        model: discoveryResult.model,
        tokensIn: discoveryResult.tokensIn,
        tokensOut: discoveryResult.tokensOut,
        scanId,
        repoId,
      }).catch((err: Error) => console.error("[securityContext] recordAiUsage(discovery) failed:", err.message));

      saveRepoSecurityContext(repoId, repoSecurityContext).catch((err: Error) =>
        console.error("[securityContext] saveRepoSecurityContext failed:", err.message),
      );
    }

    recordAiUsage({
      surface: "classifier",
      model: classifyResult.model,
      tokensIn: classifyResult.tokensIn,
      tokensOut: classifyResult.tokensOut,
      scanId,
      repoId,
    }).catch((err: Error) => console.error("[securityContext] recordAiUsage(classifier) failed:", err.message));

    return {
      repoSecurityContext: await withFalsePositiveNotes(repoId, repoSecurityContext),
      classification: classifyResult.classification,
    };
  } catch (err) {
    console.warn("[securityContext] refresh failed — falling back to cached/empty context:", (err as Error).message);
    return { repoSecurityContext: await withFalsePositiveNotes(repoId, cached?.context ?? "") };
  }
}
