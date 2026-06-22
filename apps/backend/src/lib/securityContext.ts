import { discoverSecurityContext, classifyProject } from "./ai";
import { fetchRepoAuthFiles, fetchRepoManifestFiles, AUTH_FILE_CANDIDATES } from "./github";
import {
  getRepoSecurityContext,
  saveRepoSecurityContext,
  recordAiUsage,
  getFalsePositivePatterns,
} from "../db/queries";
import { extractPathsFromDiff } from "../../../../packages/scanner-contract/classifier";
import type { ProjectClassification } from "../../../../packages/scanner-contract/scanner-rules";

const DEFAULT_TTL_DAYS = 90;
const AUTH_FILE_SET = new Set(AUTH_FILE_CANDIDATES);

function getTtlDays(): number {
  const raw = process.env.DISCOVERY_CACHE_TTL_DAYS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

function isStale(updatedAt: string | null, ttlDays: number): boolean {
  // Defensive — saveRepoSecurityContext always sets this, but treat a missing
  // timestamp as stale rather than trusting an undated cache indefinitely.
  if (!updatedAt) return true;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}

function touchesAuthFiles(diffPaths: string[]): boolean {
  return diffPaths.some((p) => AUTH_FILE_SET.has(p));
}

/**
 * Appends learned false-positive notes to the security context — categories
 * dismissed 2+ times in this repo. Queried fresh on every call (cheap DB read,
 * no AI tokens) regardless of whether discovery itself was refreshed, since
 * dismissals happen continuously and shouldn't wait on the discovery TTL.
 */
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

/**
 * Returns the repo's cached security context plus a fresh project-type
 * classification, refreshing the discovery cache when:
 *  - it has never been discovered for this repo,
 *  - this diff touches a known auth-file path or .gitsentry/context.md
 *    (the cache could now be wrong about how auth/authz works), or
 *  - the cache is older than DISCOVERY_CACHE_TTL_DAYS (default 90) — catches
 *    drift that doesn't show up as a local file change, e.g. an external
 *    auth gateway being added or removed.
 * The classifier always re-runs (cheap, no extra file fetches) regardless of
 * cache freshness, so project-type rules stay accurate scan to scan.
 * Used by both the per-PR scan worker and the security-sweep endpoint.
 */
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
      authFiles.length > 0 ? discoverSecurityContext(authFiles, repoFullName) : Promise.resolve(null),
      classifyProject(allPaths, repoFullName, manifestContent ?? undefined),
    ]);

    // No fresh auth files found this round (transient fetch issue, or none
    // match our candidate list right now) — keep the last known-good context
    // rather than wiping it to empty.
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
