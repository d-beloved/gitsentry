// AI config lives in AI_* env vars. Each provider can also be configured side by
// side as AI_<PROVIDER>_*; one is active at a time (admin switch, else AI_PROVIDER).

export const VENDORS = ["anthropic", "gemini", "openai_compat"] as const;

export type Vendor = (typeof VENDORS)[number];
export type Transport = Vendor;

export function isVendor(value: unknown): value is Vendor {
  return typeof value === "string" && (VENDORS as readonly string[]).includes(value);
}

// Settings that must never fall back to the unprefixed name, so one provider can't send another's model id.
function isVendorBound(suffix: string): boolean {
  return (
    suffix === "API_KEY" ||
    suffix === "BASE_URL" ||
    suffix === "STRUCTURED_MODE" ||
    suffix === "PROVIDER_ORDER" ||
    suffix === "ALLOW_FALLBACKS" ||
    suffix.endsWith("_MODEL") ||
    suffix.endsWith("EXTRA_BODY")
  );
}

let runtimeVendor: Vendor | null = null;

/** null hands the choice back to AI_PROVIDER. Callers validate with assertVendorConfig() first. */
export function setActiveVendor(vendor: Vendor | null): void {
  runtimeVendor = vendor;
}

/** The active provider, or null for the unprefixed AI_* config. */
export function activeVendor(): Vendor | null {
  if (runtimeVendor) return runtimeVendor;
  const fromEnv = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (!fromEnv) return null;
  if (!isVendor(fromEnv)) {
    throw new Error(`AI_PROVIDER must be one of ${VENDORS.join(", ")} — got "${fromEnv}"`);
  }
  return fromEnv;
}

export function envName(vendor: Vendor | null, suffix: string): string {
  return vendor ? `AI_${vendor.toUpperCase()}_${suffix}` : `AI_${suffix}`;
}

/** Providers with an API key set. */
export function configuredVendors(): Vendor[] {
  return VENDORS.filter((v) => !!process.env[envName(v, "API_KEY")]);
}

const warned = new Set<string>();

/** AI_<PROVIDER>_<suffix>, then (unless vendor-bound) AI_<suffix>, then the deprecated GEMINI_<suffix>. */
export function envFor(vendor: Vendor | null, suffix: string): string | undefined {
  if (vendor) {
    const scoped = process.env[envName(vendor, suffix)];
    if (scoped) return scoped;
    if (isVendorBound(suffix)) return undefined;
  }

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

export function requireEnvFor(vendor: Vendor | null, suffix: string): string {
  const value = envFor(vendor, suffix);
  if (!value) throw new Error(`${envName(vendor, suffix)} is not set`);
  return value;
}

export function aiEnv(suffix: string): string | undefined {
  return envFor(activeVendor(), suffix);
}

export function requireAiEnv(suffix: string): string {
  return requireEnvFor(activeVendor(), suffix);
}
