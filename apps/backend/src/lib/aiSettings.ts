import { supabase } from "../db/client";
import {
  activeVendor,
  configuredVendors,
  envFor,
  isVendor,
  setActiveVendor,
  type Vendor,
} from "../../../../packages/ai-provider";
import { assertScannerConfig } from "./ai";

// Polls app_settings 'ai_vendor' (set from /admin/settings) and reports the outcome as
// 'ai_provider_status', since the web app can't see this process's env.

const DEFAULT_INTERVAL_MS = 30_000;

let lastRequested: string | null | undefined;
let warnedMissingTable = false;

function switchableVendors(): Vendor[] {
  return configuredVendors().filter((vendor) => {
    try {
      assertScannerConfig(vendor);
      return true;
    } catch {
      return false;
    }
  });
}

function modelsFor(vendor: Vendor | null) {
  const scan = envFor(vendor, "SCAN_MODEL") ?? null;
  return {
    scan,
    sweep: envFor(vendor, "SWEEP_MODEL") ?? null,
    discovery: envFor(vendor, "DISCOVERY_MODEL") ?? null,
    verifier: envFor(vendor, "VERIFIER_MODEL") ?? scan,
  };
}

async function writeStatus(requested: string | null, error: string | null): Promise<void> {
  const available = switchableVendors();
  const envVendor = process.env.AI_PROVIDER?.trim().toLowerCase() || null;
  const envDefault = isVendor(envVendor) ? envVendor : null;
  const { error: dbError } = await supabase.from("app_settings").upsert({
    key: "ai_provider_status",
    value: {
      active: activeVendor(),
      requested,
      available,
      models: Object.fromEntries(available.map((v) => [v, modelsFor(v)])),
      env_default: { vendor: envDefault, ...modelsFor(envDefault) },
      error,
      checked_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  });
  if (dbError) console.error("[ai-settings] could not write status:", dbError.message);
}

/** Applies a changed selection; a refused one leaves the current provider serving. */
export async function syncActiveVendor(): Promise<void> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "ai_vendor")
    .maybeSingle();

  if (error) {
    // Table missing until migration 009 runs; the env default serves meanwhile.
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn(`[ai-settings] cannot read app_settings (${error.message}) — using the env default`);
    }
    return;
  }

  const raw = (data?.value as { vendor?: unknown } | null)?.vendor;
  const requested = typeof raw === "string" && raw ? raw : null;
  if (requested === lastRequested) return;
  lastRequested = requested;

  if (requested !== null && !isVendor(requested)) {
    console.error(`[ai-settings] refused unknown vendor "${requested}"`);
    await writeStatus(requested, `Unknown vendor "${requested}"`);
    return;
  }

  try {
    if (requested) assertScannerConfig(requested);
    const previous = activeVendor();
    setActiveVendor(requested);
    if (previous !== activeVendor()) {
      console.log(`[ai-settings] AI vendor switched: ${previous ?? "env default"} → ${activeVendor() ?? "env default"}`);
    }
    await writeStatus(requested, null);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[ai-settings] refused switch to ${requested}: ${message}`);
    await writeStatus(requested, message);
  }
}

export function startAiSettingsSync(): NodeJS.Timeout | null {
  if (process.env.AI_SETTINGS_SYNC === "off") {
    console.log("[ai-settings] Disabled via AI_SETTINGS_SYNC=off");
    return null;
  }

  let inFlight = false;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    syncActiveVendor()
      .catch((err: Error) => console.error("[ai-settings] sync failed:", err.message))
      .finally(() => {
        inFlight = false;
      });
  };

  tick();
  const timer = setInterval(tick, DEFAULT_INTERVAL_MS);
  timer.unref();
  return timer;
}
