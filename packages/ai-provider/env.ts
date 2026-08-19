/**
 * Vendor-neutral AI env vars.
 *
 * Moved here from apps/backend so both apps and eval/run.ts read the config the
 * same way; apps/backend/src/lib/aiEnv.ts re-exports it for existing callers.
 *
 * The config used to be named after one vendor (GEMINI_API_KEY, GEMINI_SCAN_MODEL,
 * …), which made the provider look like a fixed property of the app rather than a
 * setting. Everything now reads AI_* — AI_API_KEY, AI_SCAN_MODEL, AI_SWEEP_MODEL,
 * AI_DISCOVERY_MODEL, AI_VERIFIER_MODEL, plus the provider vars in ./index.ts.
 *
 * The GEMINI_* names still work so a deploy that hasn't had its env updated keeps
 * running, but they warn once on first read and will be dropped in a later release.
 */

const warned = new Set<string>();

/**
 * Reads `AI_<suffix>`, falling back to the deprecated `GEMINI_<suffix>`.
 *
 * @param suffix env var name without the vendor prefix, e.g. "SCAN_MODEL"
 */
export function aiEnv(suffix: string): string | undefined {
  const current = process.env[`AI_${suffix}`];
  if (current) return current;

  const legacy = process.env[`GEMINI_${suffix}`];
  if (legacy && !warned.has(suffix)) {
    warned.add(suffix);
    console.warn(
      `[ai] GEMINI_${suffix} is deprecated — rename it to AI_${suffix}. ` +
        `The old name will stop being read in a future release.`,
    );
  }
  return legacy;
}

/** Same as aiEnv(), but throws when neither name is set. */
export function requireAiEnv(suffix: string): string {
  const value = aiEnv(suffix);
  if (!value) throw new Error(`AI_${suffix} is not set`);
  return value;
}
