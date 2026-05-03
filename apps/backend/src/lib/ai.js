const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Analyzes a code diff for security vulnerabilities.
 * @param {string} diff - The raw git diff text
 * @param {object} context - { repo, branch, triggerType, author }
 * @returns {Promise<{issues: import('../../../packages/shared/types').Finding[], summary: string}>}
 */
async function analyzeCode(diff, context) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });

  const prompt = buildPrompt(diff, context);
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  try {
    const parsed = JSON.parse(text);
    // Ensure we always return the expected shape
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: parsed.summary || "Analysis complete.",
    };
  } catch (e) {
    console.error("[ai] Response parse error:", e);
    return { issues: [], summary: "Analysis failed — could not parse response." };
  }
}

function buildPrompt(diff, context) {
  return `
You are a senior application security engineer specialising in vulnerabilities
introduced by AI coding assistants (GitHub Copilot, Cursor, Claude Code).

AI-generated code has predictable failure patterns. Your job is to identify them.

CONTEXT:
- Repository: ${context.repo}
- Branch: ${context.branch}
- Trigger: ${context.triggerType}
- Author: ${context.author || "unknown"}

SECURITY CATEGORIES TO CHECK (in order of importance):
1. hardcoded_secret — API keys, tokens, passwords, private keys in code
2. missing_auth — New routes or endpoints with no authentication check
3. sql_injection — User input concatenated into SQL queries
4. idor — User-supplied IDs used to fetch resources without ownership check
5. verbose_error — Stack traces, internal paths, or DB errors exposed to client
6. unvalidated_input — User input passed to dangerous operations without sanitisation
7. missing_rate_limit — New auth endpoints, password resets, or sensitive actions with no rate limiting
8. path_traversal — User input used in file system operations
9. xss — Unsanitised user content rendered in HTML responses
10. open_redirect — User-controlled redirect URLs

DIFF TO ANALYSE:
${diff.slice(0, 12000)}

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no explanation:
{
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "<one of the 10 categories above>",
      "file_path": "<file path from diff>",
      "line_number": <number or null>,
      "code_snippet": "<the problematic line or block, max 3 lines>",
      "description": "<plain English explanation of why this is a problem>",
      "fix_suggestion": "<concrete one or two line fix>"
    }
  ],
  "summary": "<one sentence overall security assessment>"
}

RULES:
- Only report real, exploitable issues. No style warnings.
- If no issues found, return { "issues": [], "summary": "No security issues detected." }
- Do not report the same issue twice.
- Severity guide: critical = immediate exploitation possible, high = likely exploitable,
  medium = exploitable in specific conditions, low = best practice violation
`;
}

// ─── Claude drop-in (swap when ready) ────────────────────────────────────────
// async function analyzeCode(diff, context) {
//   const Anthropic = require('@anthropic-ai/sdk');
//   const client = new Anthropic();
//   const message = await client.messages.create({
//     model: 'claude-sonnet-4-5',
//     max_tokens: 2048,
//     messages: [{ role: 'user', content: buildPrompt(diff, context) }]
//   });
//   return JSON.parse(message.content[0].text);
// }

module.exports = { analyzeCode };
