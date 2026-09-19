import OpenAI from "openai";
import type { ProviderAdapter, ProviderResponse } from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { nativeCost } from "./pricing";
import { getKey } from "./keyStore";

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

  function getClient(): OpenAI {
    const apiKey = getKey(providerKeyId);
    if (!apiKey) {
      throw new Error(
        `${providerLabel} isn't configured — add a key on the admin panel's API Keys page, or set the env var in backend/.env`
      );
    }
    return new OpenAI({ apiKey, baseURL });
  }

  return {
    id,
    async call(request: RouteRequest): Promise<ProviderResponse> {
      const response = await getClient().chat.completions.create({
        model,
        messages: [{ role: "user", content: request.input }],
      });

      const content = response.choices[0]?.message?.content ?? "";
      const usage = {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      };

      return { content, usage, native_cost: nativeCost(model, usage) };
    },
    async streamCall(request: RouteRequest, onDelta: (text: string) => void): Promise<ProviderResponse> {
      const stream = await getClient().chat.completions.create({
        model,
        messages: [{ role: "user", content: request.input }],
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
