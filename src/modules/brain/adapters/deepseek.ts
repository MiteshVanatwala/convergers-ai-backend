import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// DeepSeek's OpenAI-compatible endpoint — https://api-docs.deepseek.com
export const deepseekAdapter = createOpenAICompatibleAdapter({
  id: "deepseek:deepseek-chat",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com/v1",
  providerKeyId: "deepseek",
  providerLabel: "DeepSeek",
});
