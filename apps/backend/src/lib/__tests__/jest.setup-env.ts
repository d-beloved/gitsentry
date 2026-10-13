// ai.ts requires these at module load; dummy values let it load in tests.
process.env.AI_API_KEY ??= "test-key";
process.env.AI_SCAN_MODEL ??= "test-scan-model";
process.env.AI_SWEEP_MODEL ??= "test-sweep-model";
process.env.AI_DISCOVERY_MODEL ??= "test-discovery-model";
