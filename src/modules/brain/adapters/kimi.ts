import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Moonshot AI's OpenAI-compatible endpoint for Kimi — https://platform.moonshot.ai/docs
export const kimiAdapter = createOpenAICompatibleAdapter({
  id: "kimi:kimi-k2",
  model: "kimi-k2-0711-preview",
  baseURL: "https://api.moonshot.ai/v1",
  providerKeyId: "kimi",
  providerLabel: "Kimi",
});
