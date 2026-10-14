import type { RouteRequest } from "@convergers-ai/shared-types";
import type { Effort } from "../classifier";
import type { BrainRequest } from "./types";

/**
 * Maps the classifier's effort onto each provider's own reasoning control.
 * Only controls documented by the provider are sent — a model without an
 * entry here just runs at its default. "standard" mostly leaves the default,
 * except DeepSeek, which thinks at high effort on every request by default.
 *
 *   DeepSeek  https://api-docs.deepseek.com/guides/thinking_mode
 *             thinking on by default (high); `thinking: {type: "disabled"}`, `reasoning_effort` low|high|max
 *   Gemini    https://ai.google.dev/gemini-api/docs/openai
 *             `reasoning_effort` minimal|low|medium|high; can't be turned off on 3.x
 *   Groq      https://console.groq.com/docs/reasoning
 *             gpt-oss: `reasoning_effort` low|medium|high (reasoning comes back separately)
 *             Qwen: off by default; with reasoning on, `reasoning_format: "hidden"` keeps
 *             the <think> text out of the answer
 *   Anthropic `output_config.effort` low|medium|high|xhigh|max on Sonnet 5.5 / Opus 5.5
 *             (adaptive thinking is always on); Haiku 4.5 rejects it
 */

/** Extra chat-completions body fields; spread into the request. */
export type OpenAIReasoningParams = {
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high";
  reasoning_format?: "hidden";
  thinking?: { type: "enabled" | "disabled" };
};

export type ReasoningControl = (effort: Effort) => OpenAIReasoningParams;

export function requestEffort(request: RouteRequest): Effort | undefined {
  return (request as BrainRequest).effort;
}

export const deepseekReasoning: ReasoningControl = (effort) => {
  if (effort === "quick") return { thinking: { type: "disabled" } };
  return { reasoning_effort: effort === "deep" ? "high" : "low" };
};

export const geminiReasoning: ReasoningControl = (effort) => {
  if (effort === "quick") return { reasoning_effort: "low" };
  return effort === "deep" ? { reasoning_effort: "high" } : {};
};

export const gptOssReasoning: ReasoningControl = (effort) => {
  if (effort === "quick") return { reasoning_effort: "low" };
  return effort === "deep" ? { reasoning_effort: "high" } : {};
};

export const qwenReasoning: ReasoningControl = (effort) =>
  effort === "deep" ? { reasoning_effort: "high", reasoning_format: "hidden" } : {};

/** Anthropic `output_config.effort`; undefined leaves the model's default. */
export function anthropicEffort(effort: Effort | undefined): "low" | "high" | undefined {
  if (effort === "quick") return "low";
  if (effort === "deep") return "high";
  return undefined;
}
