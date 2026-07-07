import parseDiff from "parse-diff";
import type { Finding } from "../../../../packages/scanner-contract/types";

/**
 * Deterministic secrets detection layered under the LLM scan.
 *
 * Well-known credential formats (AWS keys, GitHub tokens, Stripe live keys,
 * private key blocks…) are exactly what pattern matching does perfectly:
 * free, instant, and it never hallucinates. The LLM still catches secrets
 * these rules can't (novel formats, split strings); when both flag the same
 * line the deterministic finding wins — it is verified, not inferred.
 */

interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  severity: "critical" | "high";
}

// Vendor-specific token formats. Anchored to distinctive prefixes so false
// positives are near-impossible; all are reported at high confidence.
const SECRET_RULES: SecretRule[] = [
  {
    id: "aws-access-key-id",
    description: "AWS access key ID",
    pattern: /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
    severity: "critical",
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/,
    severity: "critical",
  },
  {
    id: "stripe-live-key",
    description: "Stripe live secret key",
    pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/,
    severity: "critical",
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    severity: "critical",
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: "high",
  },
  {
    id: "openai-api-key",
    description: "OpenAI API key",
    pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/,
    severity: "critical",
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
    severity: "critical",
  },
  {
    id: "sendgrid-api-key",
    description: "SendGrid API key",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
    severity: "critical",
  },
  {
    id: "npm-token",
    description: "npm access token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
    severity: "high",
  },
  {
    id: "private-key-block",
    description: "Private key material",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/,
    severity: "critical",
  },
  {
    id: "jwt",
    description: "Hardcoded JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    severity: "high",
  },
];

// Generic "secret-ish assignment" — requires both a suspicious variable name
// and a high-entropy literal value, plus the placeholder filters below.
const GENERIC_ASSIGNMENT =
  /(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([^"']{12,})["']/i;

const PLACEHOLDER_HINTS = [
  "example",
  "placeholder",
  "changeme",
  "change-me",
  "your-",
  "your_",
  "dummy",
  "sample",
  "redacted",
  "xxxx",
  "****",
  "<",
  ">",
  "${",
  "{{",
  "process.env",
  "env(",
  "getenv",
  "todo",
  "insert-",
  "abc123",
  "123456",
];

function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return PLACEHOLDER_HINTS.some((h) => v.includes(h));
}

/** Shannon entropy in bits per character. Real keys sit well above 3.5. */
export function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Never echo a full secret back into a PR comment. */
export function redactSecret(line: string, secret: string): string {
  const redacted =
    secret.length <= 8
      ? "[REDACTED]"
      : `${secret.slice(0, 6)}…[REDACTED]`;
  return line.replace(secret, redacted);
}

const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /\.snap$/,
  /\.svg$/,
];

export interface DetectedSecret {
  finding: Finding;
  /** file path + line — used to dedupe overlapping LLM findings */
  filePath: string;
  lineNumber: number;
}

export function detectSecretsInDiff(diffText: string | null | undefined): DetectedSecret[] {
  if (!diffText) return [];

  const results: DetectedSecret[] = [];
  let files: ReturnType<typeof parseDiff>;
  try {
    files = parseDiff(diffText);
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = file.to ?? file.from ?? "unknown";
    if (SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;

    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type !== "add") continue;
        const line = change.content.slice(1);
        const ln = change.ln ?? 0;

        let matched = false;
        for (const rule of SECRET_RULES) {
          const m = line.match(rule.pattern);
          if (!m) continue;
          const secret = m[0];
          if (looksLikePlaceholder(secret)) continue;
          results.push(buildDetection(filePath, ln, line, secret, rule.description, rule.severity));
          matched = true;
          break;
        }
        if (matched) continue;

        const generic = line.match(GENERIC_ASSIGNMENT);
        if (generic) {
          const value = generic[1];
          if (!looksLikePlaceholder(value) && shannonEntropy(value) >= 3.5) {
            results.push(
              buildDetection(filePath, ln, line, value, "High-entropy credential assignment", "high"),
            );
          }
        }
      }
    }
  }

  return results;
}

function buildDetection(
  filePath: string,
  lineNumber: number,
  line: string,
  secret: string,
  what: string,
  severity: "critical" | "high",
): DetectedSecret {
  const snippet = redactSecret(line.trim(), secret);
  return {
    filePath,
    lineNumber,
    finding: {
      severity,
      category: "hardcoded_secret",
      file_path: filePath,
      line_number: lineNumber,
      code_snippet: snippet.slice(0, 300),
      description: `${what} committed in source. Detected by deterministic pattern matching (not AI inference) — anyone with read access to this repository or its git history can use this credential.`,
      fix_suggestion:
        "Move the value to an environment variable or secret manager, and rotate the exposed credential immediately — it must be considered compromised once committed.",
      affected_component: "backend",
      exploitation_scenario:
        "(1) Attacker obtains repo read access (public repo, leaked clone, or compromised account), (2) extracts the credential from source or git history, (3) uses it directly against the provider API.",
      impact: "Full use of the exposed credential's privileges.",
      evidence: `Added line ${lineNumber} in ${filePath}: ${snippet.slice(0, 200)}`,
      confidence: "high",
      attacker_profile: "anonymous",
    },
  };
}

/**
 * Merges deterministic secret detections with AI findings. When the AI also
 * flagged a hardcoded secret on (or near) the same line, the deterministic
 * finding replaces it — pattern-verified beats inferred.
 */
export function mergeSecretFindings(detected: DetectedSecret[], aiIssues: Finding[]): Finding[] {
  if (!detected.length) return aiIssues;

  const kept = aiIssues.filter((issue) => {
    if (issue.category !== "hardcoded_secret") return true;
    return !detected.some(
      (d) =>
        d.filePath === issue.file_path &&
        (issue.line_number == null || Math.abs(d.lineNumber - issue.line_number) <= 2),
    );
  });

  return [...detected.map((d) => d.finding), ...kept];
}
