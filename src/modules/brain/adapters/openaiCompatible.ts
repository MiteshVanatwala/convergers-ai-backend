import OpenAI from "openai";
import {
  estimateOutputTokens,
  outputTokenLimit,
  withSystemNote,
  type ProviderAdapter,
  type ProviderResponse,
} from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { nativeCost, type TokenUsage } from "./pricing";
import { resolveKeyForAccount } from "./accountKeyResolver";
import { estimateInputTokens } from "../router/credits";
import { requestEffort, type OpenAIReasoningParams, type ReasoningControl } from "./reasoning";

// Some open-weight models default to an agentic/tool-calling persona and
// will hallucinate <tool_call> syntax for tools that don't exist — this
// gateway never sends a `tools` schema to any provider, so make that
// explicit rather than leaving the model to guess its own role.
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. You do not have access to any tools, files, code execution, or external systems — respond directly with your complete answer as plain text/markdown. Never emit tool calls, function calls, or similar syntax. " +
  "Put any code — even a single line or shell command — in a fenced Markdown code block tagged with its language (for example ```python or ```bash). " +
  "Do this even when asked for only the code: the fence is how code is displayed here, not extra text.";

// Always sent explicitly: provider defaults vary (and some are large), which
// would make the pre-call credit check meaningless. 8192 is within every
// wired-up provider's output limit (DeepSeek's is the lowest at 8K).
const MAX_OUTPUT_TOKENS = 8192;

function buildMessages(request: RouteRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    { role: "system" as const, content: withSystemNote(SYSTEM_PROMPT, request) },
    ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: request.input },
  ];
}

/**
 * Providers cache repeated prompt prefixes automatically and bill those tokens
 * at a discount, but report the cached count under different names: OpenAI,
 * Groq and Gemini use `prompt_tokens_details.cached_tokens`, DeepSeek
 * `prompt_cache_hit_tokens`, Moonshot (Kimi) a top-level `cached_tokens`.
 */
function toUsage(u: OpenAI.CompletionUsage | undefined | null): TokenUsage {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const extra = u as OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; cached_tokens?: number };
  const cached = u.prompt_tokens_details?.cached_tokens ?? extra.prompt_cache_hit_tokens ?? extra.cached_tokens ?? 0;
  const input = u.prompt_tokens ?? 0;
  // Reasoning tokens are billed as output. Most providers count them in
  // completion_tokens; one that reports them only in total_tokens would
  // otherwise be under-billed, so take whichever is larger.
  const output = Math.max(u.completion_tokens ?? 0, (u.total_tokens ?? 0) - input);
  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: Math.min(Math.max(0, cached), input),
  };
}

/**
 * Shared factory for any provider that speaks OpenAI's chat-completions
 * wire format (DeepSeek, GLM, Kimi, Qwen, and others all do) — same call
 * shape as OpenAI itself, just a different base URL and API key. Mirrors
 * anthropic.ts's per-call client construction: cheap, and it means a key set
 * via the admin panel's API Keys page takes effect on the very next request.
 */
export function createOpenAICompatibleAdapter(config: {
  id: string;
  model: string;
  baseURL: string;
  providerKeyId: string;
  providerLabel: string;
  /** The provider's reasoning control (reasoning.ts); omitted = always the model's default. */
  reasoning?: ReasoningControl;
  /** Provider-specific body fields sent on every request (e.g. OpenRouter's `provider` preferences). */
  extraBody?: Record<string, unknown>;
}): ProviderAdapter {
  const { id, model, baseURL, providerKeyId, providerLabel, reasoning, extraBody } = config;

  function reasoningParams(request: RouteRequest): OpenAIReasoningParams {
    const effort = requestEffort(request);
    return reasoning && effort ? reasoning(effort) : {};
  }

  async function getClient(accountId: string | null): Promise<OpenAI> {
    const apiKey = await resolveKeyForAccount(id, providerKeyId, providerLabel, accountId);
    return new OpenAI({ apiKey, baseURL });
  }

  return {
    id,
    keyProviderId: providerKeyId,
    cost: { kind: "tokens", model, maxOutputTokens: MAX_OUTPUT_TOKENS },
    async call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse> {
      const startedAt = new Date();
      const client = await getClient(accountId);
      const response = await client.chat.completions.create({
        model,
        messages: buildMessages(request),
        max_tokens: outputTokenLimit(MAX_OUTPUT_TOKENS, request),
        ...reasoningParams(request),
        ...extraBody,
      });

      const content = response.choices[0]?.message?.content ?? "";
      const usage = toUsage(response.usage);

      return {
        content,
        usage,
        native_cost: nativeCost(model, usage, startedAt),
        truncated: response.choices[0]?.finish_reason === "length",
      };
    },
    async streamCall(
      request: RouteRequest,
      onDelta: (text: string) => void,
      accountId: string | null,
      _onInputTokens?: (tokens: number) => void,
      signal?: AbortSignal
    ): Promise<ProviderResponse> {
      const startedAt = new Date();
      const client = await getClient(accountId);

      let content = "";
      let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
      let truncated = false;

      try {
        const stream = await client.chat.completions.create(
          {
            model,
            messages: buildMessages(request),
            max_tokens: outputTokenLimit(MAX_OUTPUT_TOKENS, request),
            ...reasoningParams(request),
            ...extraBody,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal }
        );
        for await (const chunk of stream) {
          if (chunk.choices[0]?.finish_reason === "length") truncated = true;
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            content += delta;
            onDelta(delta);
          }
          if (chunk.usage) usage = toUsage(chunk.usage);
        }
      } catch (err) {
        if (!signal?.aborted) throw err;
        // Usage only arrives in the final chunk, which a stopped stream never gets.
        usage = { input_tokens: estimateInputTokens(request), output_tokens: estimateOutputTokens(content) };
        return { content, usage, native_cost: nativeCost(model, usage, startedAt), stopped: true };
      }

      return { content, usage, native_cost: nativeCost(model, usage, startedAt), truncated };
    },
  };
}
