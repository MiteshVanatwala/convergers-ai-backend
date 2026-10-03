import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// xAI's OpenAI-compatible endpoint for Grok — https://docs.x.ai/overview
// Use a canonical version id (not a "-latest" alias) per xAI's own guidance.
export const xaiAdapter = createOpenAICompatibleAdapter({
  id: "xai:grok-4.6",
  model: "grok-4.6",
  baseURL: "https://api.x.ai/v1",
  providerKeyId: "xai",
  providerLabel: "xAI (Grok)",
});

// Most cost-effective general-purpose tier.
export const grok43Adapter = createOpenAICompatibleAdapter({
  id: "xai:grok-4.3",
  model: "grok-4.3",
  baseURL: "https://api.x.ai/v1",
  providerKeyId: "xai",
  providerLabel: "xAI (Grok)",
});
