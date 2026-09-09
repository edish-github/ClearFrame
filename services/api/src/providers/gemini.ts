import { GoogleGenAI } from "@google/genai";
import { env } from "../core/env.js";

/**
 * Gemini is the reasoning layer. It never retrieves from the web here —
 * retrieval belongs to Parallel. Every call declares a JSON response schema so
 * the output is a database row, not prose we have to parse hopefully.
 */

export type GeminiTier = "pro" | "flash";

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  model: string;
}

export interface GeminiResult<T> {
  data: T;
  usage: GeminiUsage;
}

export interface PdfPart { mimeType: string; base64: string; }

interface CallOptions {
  tier?: GeminiTier;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  file?: PdfPart;
  maxOutputTokens?: number;
  temperature?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function priceMicros(tier: GeminiTier, inTok: number, outTok: number): number {
  const p = tier === "pro" ? env.gemini.price.pro : env.gemini.price.flash;
  const usd = (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
  return Math.round(usd * 1_000_000);
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
}

const ai = new GoogleGenAI({
  vertexai: true,
  project: env.gemini.project || "placeholder-project",
  location: env.gemini.location || "us-central1",
});

export async function generate<T>(opts: CallOptions): Promise<GeminiResult<T>> {
  const tier: GeminiTier = opts.tier ?? "flash";
  const model = tier === "pro" ? env.gemini.pro : env.gemini.flash;

  const parts: Record<string, unknown>[] = [];
  if (opts.file) {
    parts.push({
      inlineData: {
        mimeType: opts.file.mimeType,
        data: opts.file.base64,
      },
    });
  }
  parts.push({ text: opts.prompt });

  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** attempt + Math.random() * 400);

    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts } as any],
        config: {
          systemInstruction: opts.system,
          responseMimeType: "application/json",
          responseSchema: opts.schema as any,
          temperature: opts.temperature ?? 0.2,
          maxOutputTokens: opts.maxOutputTokens ?? 4096,
        },
      });

      const candidate = response.candidates?.[0];
      const finish = candidate?.finishReason;
      if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") {
        throw new ProviderError(`Gemini stopped early: ${finish}`);
      }

      // Sometimes text is in response.text, or within candidate parts
      let rawText = response.text ?? "";
      if (!rawText && candidate?.content?.parts) {
        rawText = candidate.content.parts
          .map((p: any) => p.text ?? "")
          .join("");
      }

      let data: T;
      try {
        let cleanText = rawText.trim();
        if (cleanText.startsWith("```json")) {
          cleanText = cleanText.slice(7);
        } else if (cleanText.startsWith("```")) {
          cleanText = cleanText.slice(3);
        }
        if (cleanText.endsWith("```")) {
          cleanText = cleanText.slice(0, -3);
        }
        cleanText = cleanText.trim();

        const firstBrace = cleanText.indexOf("{");
        const firstBracket = cleanText.indexOf("[");
        let startIdx = -1;
        if (firstBrace !== -1 && firstBracket !== -1) {
          startIdx = Math.min(firstBrace, firstBracket);
        } else if (firstBrace !== -1) {
          startIdx = firstBrace;
        } else if (firstBracket !== -1) {
          startIdx = firstBracket;
        }

        if (startIdx !== -1) {
          const isObject = cleanText[startIdx] === "{";
          const endChar = isObject ? "}" : "]";
          const lastIdx = cleanText.lastIndexOf(endChar);
          if (lastIdx > startIdx) {
            cleanText = cleanText.substring(startIdx, lastIdx + 1);
          }
        }

        data = JSON.parse(cleanText) as T;
      } catch (parseErr) {
        console.error("[gemini] JSON parse failed on raw response:", rawText.slice(0, 500));
        lastError = new ProviderError(`Gemini returned output that was not valid JSON: ${(parseErr as Error).message}`, undefined, true);
        continue;
      }

      const um = response.usageMetadata ?? {};
      const inputTokens = Number(um.promptTokenCount ?? 0);
      const outputTokens = Number(um.candidatesTokenCount ?? 0) + Number(um.thoughtsTokenCount ?? 0);

      return {
        data,
        usage: { inputTokens, outputTokens, model, costMicros: priceMicros(tier, inputTokens, outputTokens) },
      };
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw err;
      const msg = (err as Error).message ?? "";
      const status = (err as any)?.status ?? (err as any)?.statusCode;
      const retryable =
        status === 429 ||
        status === 500 ||
        status === 503 ||
        msg.includes("429") ||
        msg.includes("500") ||
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("fetch failed");

      lastError = new ProviderError(
        `Gemini call failed: ${msg}`,
        status,
        retryable
      );
      if (!retryable) throw lastError;
    }
  }

  throw lastError ?? new ProviderError("Gemini call failed");
}
