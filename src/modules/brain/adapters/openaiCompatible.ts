import OpenAI from "openai";
import {
  outputTokenLimit,
  withSystemNote,
  type ProviderAdapter,
  type ProviderResponse,
} from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { nativeCost, type TokenUsage } from "./pricing";
import { resolveKeyForAccount } from "./accountKeyResolver";

// Some open-weight models default to an agentic/tool-calling persona and
// will hallucinate <tool_call> syntax for tools that don't exist — this
// gateway never sends a `tools` schema to any provider, so make that
// explicit rather than leaving the model to guess its own role.
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. You do not have access to any tools, files, code execution, or external systems — respond directly with your complete answer as plain text/markdown. Never emit tool calls, function calls, or similar syntax.";

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
  return {
    input_tokens: input,
    output_tokens: u.completion_tokens ?? 0,
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
}): ProviderAdapter {
  const { id, model, baseURL, providerKeyId, providerLabel } = config;

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
      accountId: string | null
    ): Promise<ProviderResponse> {
      const startedAt = new Date();
      const client = await getClient(accountId);
      const stream = await client.chat.completions.create({
        model,
        messages: buildMessages(request),
        max_tokens: outputTokenLimit(MAX_OUTPUT_TOKENS, request),
        stream: true,
        stream_options: { include_usage: true },
      });

      let content = "";
      let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
      let truncated = false;

      for await (const chunk of stream) {
        if (chunk.choices[0]?.finish_reason === "length") truncated = true;
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        if (chunk.usage) usage = toUsage(chunk.usage);
      }

      return { content, usage, native_cost: nativeCost(model, usage, startedAt), truncated };
    },
  };
}
