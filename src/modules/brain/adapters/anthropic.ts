import Anthropic from "@anthropic-ai/sdk";
import {
  outputTokenLimit,
  withSystemNote,
  type ProviderAdapter,
  type ProviderResponse,
} from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { nativeCost } from "./pricing";
import { resolveKeyForAccount } from "./accountKeyResolver";

// Constructed fresh per call, not cached — cheap (no network I/O), and it
// means a key set via the admin panel's API Keys page (or a user's own key)
// takes effect on the very next request, not just after a restart.
async function getClient(id: string, accountId: string | null): Promise<Anthropic> {
  const apiKey = await resolveKeyForAccount(id, "anthropic", "Anthropic", accountId);
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
// Same rationale as openaiCompatible.ts's SYSTEM_PROMPT — makes explicit that
// no tools/files/code-execution exist here, so a model doesn't guess its own
// agentic role for coding-flavored prompts.
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. You do not have access to any tools, files, code execution, or external systems — respond directly with your complete answer as plain text/markdown. Never emit tool calls, function calls, or similar syntax.";

// Long code answers (whole files) routinely ran past the old 4096 cap and
// were silently cut off. Kept under ~21k so the SDK still allows the
// non-streaming `call` path (it rejects requests expected to exceed 10 min).
const MAX_OUTPUT_TOKENS = 16000;

function buildMessages(request: RouteRequest): Anthropic.MessageParam[] {
  return [
    ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: request.input },
  ];
}

export function createAnthropicAdapter(id: string, model: string): ProviderAdapter {
  return {
    id,
    keyProviderId: "anthropic",
    cost: { kind: "tokens", model, maxOutputTokens: MAX_OUTPUT_TOKENS },
    async call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse> {
      const client = await getClient(id, accountId);
      const response = await client.messages.create({
        model,
        max_tokens: outputTokenLimit(MAX_OUTPUT_TOKENS, request),
        system: withSystemNote(SYSTEM_PROMPT, request),
        messages: buildMessages(request),
      });

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };

      return {
        content,
        usage,
        native_cost: nativeCost(model, usage),
        truncated: response.stop_reason === "max_tokens",
      };
    },
    async streamCall(
      request: RouteRequest,
      onDelta: (text: string) => void,
      accountId: string | null,
      onInputTokens?: (tokens: number) => void
    ): Promise<ProviderResponse> {
      const client = await getClient(id, accountId);
      const stream = client.messages.stream({
        model,
        max_tokens: outputTokenLimit(MAX_OUTPUT_TOKENS, request),
        system: withSystemNote(SYSTEM_PROMPT, request),
        messages: buildMessages(request),
      });
      stream.on("text", onDelta);
      // message_start carries the exact prompt token count before any
      // output text streams — the one place in this codebase real (not
      // estimated) usage is available ahead of completion.
      if (onInputTokens) {
        stream.on("streamEvent", (event) => {
          if (event.type === "message_start") {
            onInputTokens(event.message.usage.input_tokens);
          }
        });
      }

      const response = await stream.finalMessage();
      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };

      return {
        content,
        usage,
        native_cost: nativeCost(model, usage),
        truncated: response.stop_reason === "max_tokens",
      };
    },
  };
}

// Cheap/fast tier — default for plain text.
export const haikuAdapter = createAnthropicAdapter("anthropic:claude-haiku-4-5", "claude-haiku-4-5");
// Stronger tier — code and research, and the fallback for text if Haiku fails.
export const sonnetAdapter = createAnthropicAdapter("anthropic:claude-sonnet-5", "claude-sonnet-5");
// Top tier — frontier-class agentic coding and reasoning.
export const opusAdapter = createAnthropicAdapter("anthropic:claude-opus-5", "claude-opus-5");
