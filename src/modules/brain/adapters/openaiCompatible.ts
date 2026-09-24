import OpenAI from "openai";
import type { ProviderAdapter, ProviderResponse } from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { nativeCost } from "./pricing";
import { resolveKeyForAccount } from "./accountKeyResolver";

// Some open-weight models default to an agentic/tool-calling persona and
// will hallucinate <tool_call> syntax for tools that don't exist — this
// gateway never sends a `tools` schema to any provider, so make that
// explicit rather than leaving the model to guess its own role.
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. You do not have access to any tools, files, code execution, or external systems — respond directly with your complete answer as plain text/markdown. Never emit tool calls, function calls, or similar syntax.";

function buildMessages(request: RouteRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: request.input },
  ];
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
    async call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse> {
      const client = await getClient(accountId);
      const response = await client.chat.completions.create({
        model,
        messages: buildMessages(request),
      });

      const content = response.choices[0]?.message?.content ?? "";
      const usage = {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      };

      return { content, usage, native_cost: nativeCost(model, usage) };
    },
    async streamCall(
      request: RouteRequest,
      onDelta: (text: string) => void,
      accountId: string | null
    ): Promise<ProviderResponse> {
      const client = await getClient(accountId);
      const stream = await client.chat.completions.create({
        model,
        messages: buildMessages(request),
        stream: true,
        stream_options: { include_usage: true },
      });

      let content = "";
      let usage = { input_tokens: 0, output_tokens: 0 };

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      return { content, usage, native_cost: nativeCost(model, usage) };
    },
  };
}
