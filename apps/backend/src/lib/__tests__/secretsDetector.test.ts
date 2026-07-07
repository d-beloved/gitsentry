import {
  detectSecretsInDiff,
  mergeSecretFindings,
  shannonEntropy,
  redactSecret,
} from "../secretsDetector";
import type { Finding } from "../../../../../packages/scanner-contract/types";

function diffWithLine(line: string, file = "src/config.ts"): string {
  return `diff --git a/${file} b/${file}
index 1234567..89abcde 100644
--- a/${file}
+++ b/${file}
@@ -1,1 +1,2 @@
 const existing = true;
+${line}
`;
}

describe("detectSecretsInDiff", () => {
  it("detects an AWS access key ID", () => {
    const results = detectSecretsInDiff(diffWithLine('const key = "AKIAIOSFODNN7EXAMPLB";'));
    expect(results).toHaveLength(1);
    expect(results[0].finding.category).toBe("hardcoded_secret");
    expect(results[0].finding.severity).toBe("critical");
    expect(results[0].lineNumber).toBe(2);
  });

  it("detects a GitHub personal access token", () => {
    const results = detectSecretsInDiff(
      diffWithLine('token: "ghp_16C7e42F292c6912E7710c838347Ae178B4a"'),
    );
    expect(results).toHaveLength(1);
  });

  it("detects a Stripe live key", () => {
    const results = detectSecretsInDiff(
      diffWithLine('const stripe = "sk_live_a1B2c3D4e5F6g7H8";'),
    );
    expect(results).toHaveLength(1);
    expect(results[0].finding.severity).toBe("critical");
  });

  it("detects a private key block", () => {
    const results = detectSecretsInDiff(diffWithLine("-----BEGIN RSA PRIVATE KEY-----"));
    expect(results).toHaveLength(1);
  });

  it("detects a generic high-entropy credential assignment", () => {
    const results = detectSecretsInDiff(
      diffWithLine('const dbPassword = "q9X$vLp2#mZ8wRt5uKfA";'),
    );
    expect(results).toHaveLength(1);
    expect(results[0].finding.severity).toBe("high");
  });

  it("redacts the secret in snippet and evidence", () => {
    const results = detectSecretsInDiff(
      diffWithLine('const stripe = "sk_live_a1B2c3D4e5F6g7H8";'),
    );
    expect(results[0].finding.code_snippet).not.toContain("sk_live_a1B2c3D4e5F6g7H8");
    expect(results[0].finding.code_snippet).toContain("[REDACTED]");
    expect(results[0].finding.evidence).not.toContain("sk_live_a1B2c3D4e5F6g7H8");
  });

  it("skips placeholders and env references", () => {
    expect(detectSecretsInDiff(diffWithLine('const key = "your-api-key-goes-here-ok";'))).toHaveLength(0);
    expect(detectSecretsInDiff(diffWithLine('password: "${DB_PASSWORD}"'))).toHaveLength(0);
    expect(detectSecretsInDiff(diffWithLine('const apiKey = "process.env.API_KEY_VALUE";'))).toHaveLength(0);
  });

  it("skips low-entropy values", () => {
    expect(detectSecretsInDiff(diffWithLine('const password = "aaaaaaaaaaaaaaaa";'))).toHaveLength(0);
  });

  it("ignores unchanged and removed lines", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,1 @@
 const key = "AKIAIOSFODNN7EXAMPLB";
-const old = "sk_live_a1B2c3D4e5F6g7H8";
`;
    expect(detectSecretsInDiff(diff)).toHaveLength(0);
  });
});

describe("shannonEntropy", () => {
  it("is low for repeated characters and high for random keys", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
    expect(shannonEntropy("q9X$vLp2#mZ8wRt5uKfA")).toBeGreaterThan(3.5);
  });
});

describe("redactSecret", () => {
  it("keeps a short prefix only", () => {
    expect(redactSecret("key = sk_live_abcdef123456", "sk_live_abcdef123456")).toBe(
      "key = sk_liv…[REDACTED]",
    );
  });
});

describe("mergeSecretFindings", () => {
  const detected = detectSecretsInDiff(
    diffWithLine('const stripe = "sk_live_a1B2c3D4e5F6g7H8";'),
  );

  it("replaces overlapping AI hardcoded_secret findings", () => {
    const aiFinding: Finding = {
      severity: "high",
      category: "hardcoded_secret",
      file_path: "src/config.ts",
      line_number: 2,
      code_snippet: "…",
      description: "AI thinks this is a secret",
      fix_suggestion: "…",
    };
    const merged = mergeSecretFindings(detected, [aiFinding]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toContain("deterministic pattern matching");
  });

  it("keeps AI findings in other files and categories", () => {
    const otherFile: Finding = {
      severity: "high",
      category: "hardcoded_secret",
      file_path: "src/other.ts",
      line_number: 9,
      code_snippet: "…",
      description: "different file",
      fix_suggestion: "…",
    };
    const sqlInjection: Finding = {
      severity: "critical",
      category: "sql_injection",
      file_path: "src/config.ts",
      line_number: 2,
      code_snippet: "…",
      description: "unrelated",
      fix_suggestion: "…",
    };
    const merged = mergeSecretFindings(detected, [otherFile, sqlInjection]);
    expect(merged).toHaveLength(3);
  });
});
