/**
 * Vendor-neutral AI env vars.
 *
 * The implementation moved to packages/ai-provider/env.ts so apps/web and
 * eval/run.ts read the same config without importing across apps. This re-export
 * keeps the existing `./aiEnv` import path working.
 */
export { aiEnv, requireAiEnv } from "../../../../packages/ai-provider/env";
