import { GoogleGenerativeAI, type ResponseSchema } from "@google/generative-ai";
import type { AIProvider, GenerateRequest, GenerateResponse } from "./types";
import { stripUnsupported } from "./schema";

// No toStrictSchema(): Gemini takes the loose OpenAPI dialect the schema literals
// use, so only keywords it rejects outright are stripped.
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const model = this.client.getGenerativeModel({
      model: req.model,
      ...(req.system ? { systemInstruction: req.system } : {}),
      generationConfig: req.schema
        ? {
            responseMimeType: "application/json",
            responseSchema: stripUnsupported(req.schema) as ResponseSchema,
          }
        : { responseMimeType: "application/json" },
    });

    // `signal` frees the socket; callers still enforce the wall clock via withAIDeadline().
    const result = await model.generateContent(req.prompt, {
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
    });

    const usage = result.response.usageMetadata;
    return {
      text: result.response.text(),
      tokensIn: usage?.promptTokenCount ?? 0,
      tokensOut: usage?.candidatesTokenCount ?? 0,
      cachedTokens: usage?.cachedContentTokenCount ?? 0,
      model: req.model,
    };
  }
}
