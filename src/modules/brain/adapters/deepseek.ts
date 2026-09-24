import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// DeepSeek's OpenAI-compatible endpoint — https://api-docs.deepseek.com
// `deepseek-chat` was retired 2026-07-24; deepseek-flash is its successor.
export const deepseekFlashAdapter = createOpenAICompatibleAdapter({
  id: "deepseek:deepseek-flash",
  model: "deepseek-flash",
  baseURL: "https://api.deepseek.com/v1",
  providerKeyId: "deepseek",
  providerLabel: "DeepSeek",
});

// Stronger reasoning tier.
export const deepseekProAdapter = createOpenAICompatibleAdapter({
  id: "deepseek:deepseek-v4-pro",
  model: "deepseek-v4-pro",
  baseURL: "https://api.deepseek.com/v1",
  providerKeyId: "deepseek",
  providerLabel: "DeepSeek",
});
