import OpenAI from "openai";
import type { ProviderAdapter, ProviderResponse } from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { getKey } from "./keyStore";

// Constructed fresh per call, not cached — see anthropic.ts for why.
function getClient(): OpenAI {
  const apiKey = getKey("openai");
  if (!apiKey) {
    throw new Error(
      "OpenAI isn't configured — add a key on the admin panel's API Keys page, or set OPENAI_API_KEY in backend/.env"
    );
  }
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
 * generates the whole image and emits it as a single "delta" — the existing
 * streaming UI (built for text) renders it unmodified because the image
 * comes back as a markdown image tag, not a special content type.
 */
export const openaiImageAdapter: ProviderAdapter = {
  id: "openai:gpt-image-1",
  async call(request: RouteRequest): Promise<ProviderResponse> {
    const response = await getClient().images.generate({
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
  async streamCall(request: RouteRequest, onDelta: (text: string) => void): Promise<ProviderResponse> {
    const result = await openaiImageAdapter.call(request);
    onDelta(result.content);
    return result;
  },
};
