import { createOpenAICompatibleAdapter } from "./openaiCompatible";
import { PRICING } from "./pricing";
import { openrouterDeepseekReasoning, openrouterReasoning, type ReasoningControl } from "./reasoning";

// OpenRouter — one key, many open-weight models — https://openrouter.ai/docs
// Each model is served by several hosts at different prices and precisions
// (provider list: GET /api/v1/models/{slug}/endpoints). Every request carries
// provider preferences so OpenRouter only picks hosts that:
//   - don't store or train on prompts (data_collection: deny);
//   - don't serve a 4-bit quantised copy (quantizations);
//   - charge no more than our pricing.ts rate (max_price, USD per MTok), so
//     a request never costs more than the credits we charged for it.
// If no host qualifies the call fails and the router falls through to the
// next model in the chain.
const QUANTIZATIONS = ["fp8", "fp16", "bf16", "fp32", "unknown"];

function openrouterModel(id: string, model: string, reasoning: ReasoningControl = openrouterReasoning) {
  const rate = PRICING[model];
  return createOpenAICompatibleAdapter({
    id,
    model,
    baseURL: "https://openrouter.ai/api/v1",
    providerKeyId: "openrouter",
    providerLabel: "OpenRouter",
    reasoning,
    extraBody: {
      provider: {
        data_collection: "deny",
        quantizations: QUANTIZATIONS,
        max_price: { prompt: rate.inputPerMTok, completion: rate.outputPerMTok },
      },
    },
  });
}

// Llama 3.3 70B — no longer in Auto routing (db/openrouter_models_v1.sql), still pickable by hand.
// Sent without provider preferences, as it was when verified live.
export const openrouterAdapter = createOpenAICompatibleAdapter({
  id: "openrouter:llama-3.3-70b-instruct",
  model: "meta-llama/llama-3.3-70b-instruct",
  baseURL: "https://openrouter.ai/api/v1",
  providerKeyId: "openrouter",
  providerLabel: "OpenRouter",
});

// Xiaomi MiMo (MIT) — took Llama's places in Auto routing; Flash is the cheap tier.
export const mimoProAdapter = openrouterModel("openrouter:mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro");
export const mimoFlashAdapter = openrouterModel("openrouter:mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash");

// DeepSeek (MIT) and GLM — replace the direct deepseek:/glm: adapters, whose accounts kept failing.
export const openrouterDeepseekFlashAdapter = openrouterModel(
  "openrouter:deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-1017",
  openrouterDeepseekReasoning
);
export const openrouterDeepseekProAdapter = openrouterModel(
  "openrouter:deepseek-v4-pro",
  "deepseek/deepseek-v4-pro-0813",
  openrouterDeepseekReasoning
);
export const openrouterGlmAdapter = openrouterModel("openrouter:glm-5.3", "z-ai/glm-5.3");

// Google Gemma 4 31B (Apache 2.0) — strong across languages.
export const gemmaAdapter = openrouterModel("openrouter:gemma-4-31b", "google/gemma-4-31b-it");

// Qwen3.8 2.4T — largest open model, premium price; picked by hand only (not in Auto routing).
export const qwenMaxOpenAdapter = openrouterModel("openrouter:qwen3.8-2.4t", "qwen/qwen3.8-2.4t-a95b");
