import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import type { Finding } from "../../../../packages/scanner-contract/types";

/**
 * Verification (judge) pass — the false-positive firewall.
 *
 * A single scan call both hunts for issues and grades its own homework; models
 * do the second part poorly in one pass. This second, cheap call takes each
 * candidate finding plus the exact scanner input and adjudicates whether the
 * claimed taint path is actually visible in the code. Findings the judge
 * REJECTS are dropped; UNCERTAIN findings survive with confidence lowered one
 * step. The pass fails open — any error or timeout returns the original
 * findings untouched, so verification can never lose a real finding to an
 * infrastructure hiccup.
 *
 * Deterministic (pattern-verified) findings are never sent to the judge.
 */

const VERIFY_TIMEOUT_MS = 45_000;

const VERDICT_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    verdicts: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          index: { type: SchemaType.INTEGER },
          verdict: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["confirmed", "uncertain", "rejected"],
          },
          reason: { type: SchemaType.STRING },
        },
        required: ["index", "verdict", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

export interface VerifyResult {
  issues: Finding[];
  dropped: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

function lowerConfidence(c: Finding["confidence"]): Finding["confidence"] {
  if (c === "high") return "medium";
  return "low";
}

function buildJudgePrompt(issues: Finding[], scannerInput: string, repo: string): string {
  const findingBlocks = issues
    .map((issue, i) => {
      return `--- FINDING ${i} ---
category: ${issue.category}
severity: ${issue.severity}
file: ${issue.file_path}${issue.line_number != null ? ` line ${issue.line_number}` : ""}
claim: ${issue.description}
evidence: ${issue.evidence ?? "(none provided)"}
snippet: ${issue.code_snippet ?? "(none provided)"}`;
    })
    .join("\n\n");

  return `You are a security finding VERIFIER. A scanner produced candidate findings for a
code change in ${repo}. Your only job is to check each finding against the code it
claims to describe — you are the false-positive filter, not a second scanner. Do
NOT invent new findings.

For each finding, verify against the code below:
1. PRESENCE — do the quoted snippet/evidence lines actually appear in the code
   (allowing for whitespace and prefix differences)?
2. TAINT PATH — is the claimed source → sink path visible? For missing-control
   findings, is the entry point visible and the control genuinely absent from
   its reachable context?
3. NEUTRALIZING GUARD — does a sanitization, parameterization, auth check,
   ownership check, or validation VISIBLE in the code neutralize the claim?
   (Sanitization must match the sink type to count.)
4. REMOVED CONTROLS — for findings about deleted lines ("- (was L<n>)"), was a
   security control actually removed while the surrounding path remains
   reachable, rather than the whole feature being deleted with it?

Verdicts:
- "confirmed": the quoted code exists and the exploit path holds as claimed.
- "uncertain": plausible, but part of the path is outside the visible code.
- "rejected": the quoted code is not present, the path is broken, or a visible
  guard neutralizes it.

When in doubt between uncertain and rejected, choose uncertain — dropping a real
vulnerability is worse than lowering its confidence.

CANDIDATE FINDINGS:
${findingBlocks}

CODE UNDER REVIEW (same input the scanner saw):
${scannerInput}

Return ONLY valid JSON: { "verdicts": [ { "index": <finding number>, "verdict": "confirmed" | "uncertain" | "rejected", "reason": "<one sentence>" } ] } with exactly one verdict per finding.`;
}

export async function verifyFindings(
  genAI: GoogleGenerativeAI,
  modelName: string,
  issues: Finding[],
  scannerInput: string,
  repo: string,
): Promise<VerifyResult> {
  const unchanged: VerifyResult = { issues, dropped: 0, tokensIn: 0, tokensOut: 0, model: modelName };
  if (!issues.length) return unchanged;

  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: VERDICT_SCHEMA,
      },
    });

    const result = await Promise.race([
      model.generateContent(buildJudgePrompt(issues, scannerInput, repo)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("verifier timed out")), VERIFY_TIMEOUT_MS),
      ),
    ]);

    const usage = result.response.usageMetadata;
    const tokensIn = usage?.promptTokenCount ?? 0;
    const tokensOut = usage?.candidatesTokenCount ?? 0;

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text) as {
      verdicts?: { index?: number; verdict?: string; reason?: string }[];
    };

    const verdictByIndex = new Map<number, { verdict: string; reason: string }>();
    for (const v of parsed.verdicts ?? []) {
      if (typeof v?.index === "number" && v.verdict) {
        verdictByIndex.set(v.index, { verdict: v.verdict, reason: v.reason ?? "" });
      }
    }

    const verified: Finding[] = [];
    let dropped = 0;
    issues.forEach((issue, i) => {
      // No verdict returned for this finding → fail open, keep it.
      const v = verdictByIndex.get(i);
      if (!v || v.verdict === "confirmed") {
        verified.push(issue);
        return;
      }
      if (v.verdict === "uncertain") {
        verified.push({ ...issue, confidence: lowerConfidence(issue.confidence) });
        return;
      }
      dropped++;
      console.log(
        `[verifier] Dropped ${issue.category} in ${issue.file_path}${issue.line_number != null ? `:${issue.line_number}` : ""} — ${v.reason}`,
      );
    });

    return { issues: verified, dropped, tokensIn, tokensOut, model: modelName };
  } catch (err) {
    console.warn("[verifier] verification failed — keeping all findings:", (err as Error).message);
    return unchanged;
  }
}
