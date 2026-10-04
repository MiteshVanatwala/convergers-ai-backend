import OpenAI from "openai";
import type { ProviderAdapter, ProviderResponse } from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { resolveKeyForAccount } from "./accountKeyResolver";
import { wantsAnimation } from "./imageRequest";

// Constructed fresh per call, not cached — see anthropic.ts for why.
async function getClient(accountId: string | null): Promise<OpenAI> {
  const apiKey = await resolveKeyForAccount("openai:gpt-image-1", "openai", "OpenAI", accountId);
  return new OpenAI({ apiKey });
}

// Flat POC estimate for one 1024x1024/medium-quality image. gpt-image-1
// bills in its own "image tokens" unit (see response.usage), which isn't
// the same per-token rate as text models — this is a rough stand-in, not a
// real rate card. Verify at https://platform.openai.com/pricing before
// relying on this for anything beyond the demo.
const IMAGE_FLAT_COST_USD = 0.04;

/**
 * OpenAI's gpt-image-1 — the first non-Anthropic provider wired up, proving
 * the router's hierarchy isn't Anthropic-specific (see router/index.ts).
 * Image generation has no token-by-token output, so `streamCall` just
 * generates the whole image. It comes back as a markdown data-URI image tag,
 * which the chat controller moves into object storage before saving.
 */
export const openaiImageAdapter: ProviderAdapter = {
  id: "openai:gpt-image-1",
  keyProviderId: "openai",
  cost: { kind: "flat", usd: IMAGE_FLAT_COST_USD },
  canHandle: (request) => !wantsAnimation(request.input),
  async call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse> {
    const client = await getClient(accountId);
    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt: request.input,
      size: "1024x1024",
      quality: "medium",
      n: 1,
    });

    const image = response.data?.[0];
    if (!image?.b64_json) {
      throw new Error("OpenAI returned no image data");
    }

    const alt = request.input.replace(/[[\]]/g, "").slice(0, 120);
    const content = `![${alt}](data:image/png;base64,${image.b64_json})`;

    return {
      content,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
      },
      native_cost: IMAGE_FLAT_COST_USD,
    };
  },
  async streamCall(
    request: RouteRequest,
    _onDelta: (text: string) => void,
    accountId: string | null
  ): Promise<ProviderResponse> {
    // The multi-MB data URI isn't sent over SSE; the client renders the
    // stored image from the "done" event (see artifacts/chat-images.ts).
    return openaiImageAdapter.call(request, accountId);
  },
};
