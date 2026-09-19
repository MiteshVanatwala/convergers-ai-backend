import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Alibaba Cloud's own DashScope signup isn't reachable from every region
// (India included, as of writing) — Qwen is served via Groq's
// OpenAI-compatible endpoint instead: https://console.groq.com/docs/models
export const qwenAdapter = createOpenAICompatibleAdapter({
  id: "qwen:qwen3.8-27b",
  model: "qwen/qwen3.8-27b",
  baseURL: "https://api.groq.com/openai/v1",
  providerKeyId: "groq",
  providerLabel: "Groq",
});
