import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Zhipu AI / Z.ai's OpenAI-compatible endpoint for GLM — https://docs.z.ai
// Flagship tier.
export const glmAdapter = createOpenAICompatibleAdapter({
  id: "glm:glm-5.3",
  model: "glm-5.3",
  baseURL: "https://api.z.ai/api/paas/v4",
  providerKeyId: "glm",
  providerLabel: "GLM",
});

// Cheap/fast tier — replaced GLM-4.6 and GLM-4.5 Air in routing (db/models_2026_10.sql):
// newer and cheaper than both ($0.15/$0.50 per MTok).
export const glmFlashAdapter = createOpenAICompatibleAdapter({
  id: "glm:glm-5.3-flash",
  model: "glm-5.3-flash",
  baseURL: "https://api.z.ai/api/paas/v4",
  providerKeyId: "glm",
  providerLabel: "GLM",
});
