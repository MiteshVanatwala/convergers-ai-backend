import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Moonshot AI's OpenAI-compatible endpoint for Kimi — https://platform.moonshot.ai/docs
// kimi-k2-0711-preview is no longer served; K2.6 replaced it (db/models_2026_10.sql).
export const kimiAdapter = createOpenAICompatibleAdapter({
  id: "kimi:kimi-k2.6",
  model: "kimi-k2.6",
  baseURL: "https://api.moonshot.ai/v1",
  providerKeyId: "kimi",
  providerLabel: "Kimi",
});

// Coding-tuned variant, same price as K2.6.
export const kimiCodeAdapter = createOpenAICompatibleAdapter({
  id: "kimi:kimi-k2.7-code",
  model: "kimi-k2.7-code",
  baseURL: "https://api.moonshot.ai/v1",
  providerKeyId: "kimi",
  providerLabel: "Kimi",
});
