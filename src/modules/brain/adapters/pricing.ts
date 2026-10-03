// Per-token pricing for the models wired up in this POC, in USD per million
// tokens. First-party rates from each provider — keep in sync with their
// pricing pages if models are added or repriced (last checked 2026-10-03).
//
// inputPerMTok / outputPerMTok are the full (uncached, peak) rates: the
// router's pre-call credit check (router/credits.ts) uses them so a request
// is never let through that the balance can't cover. nativeCost() then bills
// what the request actually cost: cached prompt tokens at the cache rate and,
// for DeepSeek, the off-peak discount.
export type ModelRate = {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Prompt tokens served from the provider's cache. Omitted = no discount known; billed at inputPerMTok. */
  cachedInputPerMTok?: number;
  /** Prompt tokens written to the cache (Anthropic charges a premium). Omitted = inputPerMTok. */
  cacheWritePerMTok?: number;
  /** Rates multiply by this outside the provider's peak hours (see isDeepSeekPeak). */
  offPeakMultiplier?: number;
};

export const PRICING: Record<string, ModelRate> = {
  // Anthropic — https://www.anthropic.com/pricing. Cache reads 0.1×, 5-minute cache writes 1.25×.
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0, cachedInputPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  "claude-sonnet-5-5": { inputPerMTok: 2.0, outputPerMTok: 10.0, cachedInputPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  "claude-opus-5-5": { inputPerMTok: 4.0, outputPerMTok: 20.0, cachedInputPerMTok: 0.4, cacheWritePerMTok: 5.0 },
  // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing. Peak rates; off-peak is half.
  // Context caching is automatic (cache-hit input).
  "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2, cachedInputPerMTok: 0.006, offPeakMultiplier: 0.5 },
  "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96, cachedInputPerMTok: 0.044, offPeakMultiplier: 0.5 },
  // GLM (Zhipu/Z.ai) — https://docs.z.ai/guides/overview/pricing
  "glm-5.3": { inputPerMTok: 1.4, outputPerMTok: 4.4, cachedInputPerMTok: 0.26 },
  "glm-5.3-flash": { inputPerMTok: 0.15, outputPerMTok: 0.5, cachedInputPerMTok: 0.03 },
  // Kimi (Moonshot) — https://platform.moonshot.ai/docs/pricing
  "kimi-k2.6": { inputPerMTok: 0.95, outputPerMTok: 4.0, cachedInputPerMTok: 0.16 },
  "kimi-k2.7-code": { inputPerMTok: 0.95, outputPerMTok: 4.0, cachedInputPerMTok: 0.19 },
  // Qwen3.8 27B via Groq — live rate from GET /openai/v1/models on Groq
  "qwen/qwen3.8-27b": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  // OpenAI gpt-oss via Groq — live rates from GET /openai/v1/models on Groq
  "openai/gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
  "openai/gpt-oss-20b": { inputPerMTok: 0.075, outputPerMTok: 0.3, cachedInputPerMTok: 0.0375 },
  // Google Gemini — https://ai.google.dev/gemini-api/docs/pricing (standard tier; implicit caching 0.1×)
  "gemini-3.8-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedInputPerMTok: 0.075 },
  "gemini-3.1-pro-preview": { inputPerMTok: 2.0, outputPerMTok: 12.0, cachedInputPerMTok: 0.2 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03 },
  // xAI Grok — https://docs.x.ai/developers/pricing (below 200K-token threshold)
  "grok-4.6": { inputPerMTok: 2.0, outputPerMTok: 6.0 },
  "grok-4.3": { inputPerMTok: 1.25, outputPerMTok: 2.5 },
  // Meta Llama 3.3 70B via OpenRouter — https://openrouter.ai/meta-llama/llama-3.3-70b-instruct
  "meta-llama/llama-3.3-70b-instruct": { inputPerMTok: 0.1, outputPerMTok: 0.32 },
};

/** What a provider reports for one request. `input_tokens` is the WHOLE prompt, cached parts included. */
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Of input_tokens, how many were read from the provider's prompt cache. */
  cached_input_tokens?: number;
  /** Of input_tokens, how many were written to the prompt cache (Anthropic). */
  cache_write_tokens?: number;
};

/**
 * DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
 * (DeepSeek also treats Chinese public holidays as off-peak; we don't track
 * those, so a holiday is billed at the peak rate — never under-charged.)
 */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

/**
 * USD cost of one request. Cached prompt tokens are billed at the cache rate,
 * cache writes at the write rate, everything else at the full rate; DeepSeek
 * models get the off-peak discount outside peak hours. `startedAt` is when the
 * request was sent — if it started or finished in peak hours it's billed as peak.
 */
export function nativeCost(model: string, usage: TokenUsage, startedAt: Date = new Date()): number {
  const rate = PRICING[model];
  if (!rate) throw new Error(`No pricing configured for model: ${model}`);

  const cached = Math.max(0, usage.cached_input_tokens ?? 0);
  const written = Math.max(0, usage.cache_write_tokens ?? 0);
  const uncached = Math.max(0, usage.input_tokens - cached - written);

  const cost =
    (uncached / 1_000_000) * rate.inputPerMTok +
    (cached / 1_000_000) * (rate.cachedInputPerMTok ?? rate.inputPerMTok) +
    (written / 1_000_000) * (rate.cacheWritePerMTok ?? rate.inputPerMTok) +
    (usage.output_tokens / 1_000_000) * rate.outputPerMTok;

  if (rate.offPeakMultiplier !== undefined && !isDeepSeekPeak(startedAt) && !isDeepSeekPeak(new Date())) {
    return cost * rate.offPeakMultiplier;
  }
  return cost;
}
