import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// OpenRouter — one key, many models. Wired up with Llama 3.3 70B as the
// flagship pick since it's genuine new coverage (no direct Meta/Llama
// adapter exists elsewhere) — https://openrouter.ai/docs
export const openrouterAdapter = createOpenAICompatibleAdapter({
  id: "openrouter:llama-3.3-70b-instruct",
  model: "meta-llama/llama-3.3-70b-instruct",
  baseURL: "https://openrouter.ai/api/v1",
  providerKeyId: "openrouter",
  providerLabel: "OpenRouter",
});
