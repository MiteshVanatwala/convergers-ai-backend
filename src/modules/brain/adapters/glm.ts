import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Zhipu AI / Z.ai's OpenAI-compatible endpoint for GLM — https://docs.z.ai
export const glmAdapter = createOpenAICompatibleAdapter({
  id: "glm:glm-4.6",
  model: "glm-4.6",
  baseURL: "https://api.z.ai/api/paas/v4",
  providerKeyId: "glm",
  providerLabel: "GLM",
});
