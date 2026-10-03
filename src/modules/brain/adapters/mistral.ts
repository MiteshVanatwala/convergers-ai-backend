import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Mistral's own API is already OpenAI-compatible in shape — https://docs.mistral.ai/api
export const mistralLargeAdapter = createOpenAICompatibleAdapter({
  id: "mistral:mistral-large-latest",
  model: "mistral-large-latest",
  baseURL: "https://api.mistral.ai/v1",
  providerKeyId: "mistral",
  providerLabel: "Mistral AI",
});

// Cheap/fast tier.
export const mistralSmallAdapter = createOpenAICompatibleAdapter({
  id: "mistral:mistral-small-latest",
  model: "mistral-small-latest",
  baseURL: "https://api.mistral.ai/v1",
  providerKeyId: "mistral",
  providerLabel: "Mistral AI",
});
