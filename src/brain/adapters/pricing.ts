// Per-token pricing for the Claude models wired up in this POC, in USD per
// million tokens. First-party Anthropic API rates — keep in sync with
// https://www.anthropic.com/pricing if models are added or repriced.
export const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
};

export function nativeCost(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const rate = PRICING[model];
  if (!rate) throw new Error(`No pricing configured for model: ${model}`);
  return (usage.input_tokens / 1_000_000) * rate.inputPerMTok + (usage.output_tokens / 1_000_000) * rate.outputPerMTok;
}
