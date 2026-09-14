import Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, ProviderResponse } from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { nativeCost } from "./pricing";
import { getKey } from "./keyStore";

// Constructed fresh per call, not cached — cheap (no network I/O), and it
// means a key set via the admin panel's API Keys page takes effect on the
// very next request, not just after a restart.
function getClient(): Anthropic {
  const apiKey = getKey("anthropic");
  if (!apiKey) {
    throw new Error(
      "Anthropic isn't configured — add a key on the admin panel's API Keys page, or set ANTHROPIC_API_KEY in backend/.env"
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * One adapter per Claude model, all backed by the single Anthropic client
 * per the technical plan's provider-access slide (pay-as-you-go,
 * console.anthropic.com). The API key never leaves this module.
 *
 * POC note: Anthropic and OpenAI (image only) are the providers wired up so
 * far. A third provider gets its own file exporting the same ProviderAdapter
 * shape and slots into the router's hierarchy the same way.
 */
export function createAnthropicAdapter(id: string, model: string): ProviderAdapter {
  return {
    id,
    async call(request: RouteRequest): Promise<ProviderResponse> {
      const response = await getClient().messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: request.input }],
      });

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };

      return { content, usage, native_cost: nativeCost(model, usage) };
    },
    async streamCall(request: RouteRequest, onDelta: (text: string) => void): Promise<ProviderResponse> {
      const stream = getClient().messages.stream({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: request.input }],
      });
      stream.on("text", onDelta);

      const response = await stream.finalMessage();
      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };

      return { content, usage, native_cost: nativeCost(model, usage) };
    },
  };
}

// Cheap/fast tier — default for plain text.
export const haikuAdapter = createAnthropicAdapter("anthropic:claude-haiku-4-5", "claude-haiku-4-5");
// Stronger tier — code and research, and the fallback for text if Haiku fails.
export const sonnetAdapter = createAnthropicAdapter("anthropic:claude-sonnet-5", "claude-sonnet-5");
