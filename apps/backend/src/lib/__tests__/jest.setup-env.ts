// ai.ts requires these at module load time (fail-fast in production if the AI
// provider isn't configured). Tests that import from ai.ts — directly or
// transitively via verifier.ts — need dummy values so the module can load;
// no test in this suite makes a real AI call.
process.env.AI_API_KEY ??= "test-key";
process.env.AI_SCAN_MODEL ??= "test-scan-model";
process.env.AI_SWEEP_MODEL ??= "test-sweep-model";
process.env.AI_DISCOVERY_MODEL ??= "test-discovery-model";
