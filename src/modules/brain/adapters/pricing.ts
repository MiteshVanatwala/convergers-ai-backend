// Per-token pricing for the models wired up in this POC, in USD per million
// tokens. First-party rates from each provider — keep in sync with their
// pricing pages if models are added or repriced.
export const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Anthropic — https://www.anthropic.com/pricing
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing (standard/cache-miss rate)
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  // GLM (Zhipu/Z.ai) — https://docs.z.ai/guides/overview/pricing
  "glm-4.6": { inputPerMTok: 0.6, outputPerMTok: 2.2 },
  // Kimi (Moonshot) — https://platform.moonshot.ai/docs/pricing
  "kimi-k2-0711-preview": { inputPerMTok: 0.6, outputPerMTok: 2.5 },
  // Qwen3.8 27B via Groq — live rate from GET /openai/v1/models on Groq
  "qwen/qwen3.8-27b": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  // OpenAI gpt-oss-120b via Groq — live rate from GET /openai/v1/models on Groq
  "openai/gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

export function nativeCost(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const rate = PRICING[model];
  if (!rate) throw new Error(`No pricing configured for model: ${model}`);
  return (usage.input_tokens / 1_000_000) * rate.inputPerMTok + (usage.output_tokens / 1_000_000) * rate.outputPerMTok;
}
