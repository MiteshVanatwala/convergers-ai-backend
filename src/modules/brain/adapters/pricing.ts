// Per-token pricing for the models wired up in this POC, in USD per million
// tokens. First-party rates from each provider — keep in sync with their
// pricing pages if models are added or repriced.
export const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Anthropic — https://www.anthropic.com/pricing
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing (cache-miss/peak rate)
  "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96 },
  // GLM (Zhipu/Z.ai) — https://docs.z.ai/guides/overview/pricing
  "glm-4.6": { inputPerMTok: 0.6, outputPerMTok: 2.2 },
  "glm-4.5-air": { inputPerMTok: 0.2, outputPerMTok: 1.1 },
  // Kimi (Moonshot) — https://platform.moonshot.ai/docs/pricing
  "kimi-k2-0711-preview": { inputPerMTok: 0.6, outputPerMTok: 2.5 },
  // Qwen3.8 27B via Groq — live rate from GET /openai/v1/models on Groq
  "qwen/qwen3.8-27b": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  // OpenAI gpt-oss-120b via Groq — live rate from GET /openai/v1/models on Groq
  "openai/gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // Google Gemini — https://ai.google.dev/gemini-api/docs/pricing
  "gemini-3.8-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75 },
  "gemini-3.1-pro-preview": { inputPerMTok: 2.0, outputPerMTok: 12.0 },
  // Mistral AI — https://mistral.ai/pricing/api
  "mistral-large-latest": { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  "mistral-small-latest": { inputPerMTok: 0.06, outputPerMTok: 0.18 },
  // xAI Grok — https://docs.x.ai/developers/pricing (below 200K-token threshold)
  "grok-4.6": { inputPerMTok: 2.0, outputPerMTok: 6.0 },
  "grok-4.3": { inputPerMTok: 1.25, outputPerMTok: 2.5 },
  // Meta Llama 3.3 70B via OpenRouter — https://openrouter.ai/meta-llama/llama-3.3-70b-instruct
  "meta-llama/llama-3.3-70b-instruct": { inputPerMTok: 0.1, outputPerMTok: 0.32 },
};

export function nativeCost(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const rate = PRICING[model];
  if (!rate) throw new Error(`No pricing configured for model: ${model}`);
  return (usage.input_tokens / 1_000_000) * rate.inputPerMTok + (usage.output_tokens / 1_000_000) * rate.outputPerMTok;
}
