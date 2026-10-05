import type { RouteRequest } from "@convergers-ai/shared-types";
import type { ProviderAdapter, ProviderResponse } from "./types";
import { resolveKeyForAccount } from "./accountKeyResolver";
import { previousImage, wantsAnimation } from "./imageRequest";
import { UserFacingError } from "../router/errors";

/**
 * Gemini's native image models ("Nano Banana") via the generateContent REST
 * endpoint — the OpenAI-compatible endpoint the text adapters use doesn't
 * return images. The image comes back as a markdown data-URI image; the chat
 * controller moves it into object storage before the answer is saved (see
 * artifacts/chat-images.ts), so data URIs never reach the database.
 *
 * Follow-ups edit: the most recent image in the conversation is sent back as
 * the model's previous turn, so "now make the sky orange" works.
 */

type Rates = {
  /** USD per prompt token (text and image input). */
  input: number;
  /** USD per text output token (captions, thinking). */
  textOutput: number;
  /** USD per image output token. */
  imageOutput: number;
};

type GeminiPart = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } };

type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
  };
};

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const ASPECT_RATIOS = ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"];

/** An explicit ratio in the prompt wins; otherwise a few plain-English hints. */
function aspectRatioFor(prompt: string): string | undefined {
  const explicit = prompt.match(/\b(\d{1,2})\s*[:x×]\s*(\d{1,2})\b/);
  if (explicit) {
    const ratio = `${explicit[1]}:${explicit[2]}`;
    if (ASPECT_RATIOS.includes(ratio)) return ratio;
  }
  if (/\b(wallpaper|banner|landscape|widescreen|cover photo|header image|thumbnail)\b/i.test(prompt)) return "16:9";
  if (/\b(portrait|poster|story|stories|reel|phone wallpaper|mobile wallpaper)\b/i.test(prompt)) return "9:16";
  return undefined;
}

function costOf(usage: GeminiResponse["usageMetadata"], rates: Rates): number {
  const prompt = usage?.promptTokenCount ?? 0;
  const candidates = usage?.candidatesTokenCount ?? 0;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  const image =
    usage?.candidatesTokensDetails?.find((d) => d.modality === "IMAGE")?.tokenCount ??
    // No per-modality breakdown: treat the whole output as image tokens (the pricier rate).
    candidates;
  const text = Math.max(0, candidates - image) + thoughts;
  return prompt * rates.input + text * rates.textOutput + image * rates.imageOutput;
}

function createGeminiImageAdapter(config: {
  id: string;
  model: string;
  rates: Rates;
  /** Pre-flight estimate for one image (affordability check only; billing uses real usage). */
  estimateUsd: number;
}): ProviderAdapter {
  const adapter: ProviderAdapter = {
    id: config.id,
    keyProviderId: "gemini",
    cost: { kind: "flat", usd: config.estimateUsd },
    // Still images only — animation requests go to a model that can draw frames.
    canHandle: (request) => !wantsAnimation(request.input),
    async call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse> {
      const apiKey = await resolveKeyForAccount(config.id, "gemini", "Google Gemini", accountId);
      const prompt = request.input;
      const earlier = await previousImage(request, accountId);
      const contents = earlier
        ? [
            { role: "model", parts: [{ inlineData: earlier }] },
            { role: "user", parts: [{ text: prompt }] },
          ]
        : [{ role: "user", parts: [{ text: prompt }] }];
      const aspectRatio = aspectRatioFor(prompt);

      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(config.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents,
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
          },
        }),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`Gemini image request failed (${res.status}): ${detail}`);
      }
      const json = (await res.json()) as GeminiResponse;

      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const images = parts.filter((p) => p.inlineData?.data && !p.thought);
      if (images.length === 0) {
        const reason = json.promptFeedback?.blockReason ?? json.candidates?.[0]?.finishReason;
        if (reason && /SAFETY|PROHIBITED|BLOCKLIST|IMAGE_SAFETY|RECITATION/i.test(reason)) {
          throw new UserFacingError(
            "The image model declined this prompt under its content rules. Try rewording it, or describe the scene differently."
          );
        }
        throw new Error(`Gemini returned no image${reason ? ` (${reason})` : ""}`);
      }
      const caption = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n\n");
      const alt = prompt.replace(/[[\]\n]/g, " ").trim().slice(0, 120);
      const markdown = images
        .map((p) => `![${alt}](data:${p.inlineData!.mimeType};base64,${p.inlineData!.data})`)
        .join("\n\n");

      const usage = json.usageMetadata;
      return {
        content: caption ? `${markdown}\n\n${caption}` : markdown,
        usage: {
          input_tokens: usage?.promptTokenCount ?? 0,
          output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        },
        native_cost: costOf(usage, config.rates),
      };
    },
    async streamCall(request: RouteRequest, _onDelta: (text: string) => void, accountId: string | null) {
      // No partial output to stream, and the multi-MB data URI shouldn't go
      // over SSE — the client renders the stored image from the "done" event.
      return adapter.call(request, accountId);
    },
  };
  return adapter;
}

// Rates: Google AI Studio list prices (https://ai.google.dev/gemini-api/docs/pricing),
// cross-checked with OpenRouter's catalog. A 1K image is ~1,290 output tokens.

/** Default — fast, good quality, strong text rendering. ~$0.08 per 1K image. */
export const geminiFlashImageAdapter = createGeminiImageAdapter({
  id: "gemini:gemini-3.1-flash-image",
  model: "gemini-3.1-flash-image",
  rates: { input: 0.5e-6, textOutput: 3e-6, imageOutput: 60e-6 },
  estimateUsd: 0.08,
});

/** Highest quality, best for complex scenes and infographics. ~$0.16 per 1K image. */
export const geminiProImageAdapter = createGeminiImageAdapter({
  id: "gemini:gemini-3-pro-image",
  model: "gemini-3-pro-image",
  rates: { input: 2e-6, textOutput: 12e-6, imageOutput: 120e-6 },
  estimateUsd: 0.16,
});

/** Budget — ~$0.04 per 1K image. */
export const geminiFlashLiteImageAdapter = createGeminiImageAdapter({
  id: "gemini:gemini-3.1-flash-lite-image",
  model: "gemini-3.1-flash-lite-image",
  rates: { input: 0.25e-6, textOutput: 1.5e-6, imageOutput: 30e-6 },
  estimateUsd: 0.04,
});
