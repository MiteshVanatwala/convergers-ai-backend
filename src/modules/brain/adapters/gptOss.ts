import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// OpenAI's own open-weight models (Apache 2.0), served via Groq — same key
// as the Qwen adapter (../qwen.ts). https://console.groq.com/docs/models
export const gptOssAdapter = createOpenAICompatibleAdapter({
  id: "groq:gpt-oss-120b",
  model: "openai/gpt-oss-120b",
  baseURL: "https://api.groq.com/openai/v1",
  providerKeyId: "groq",
  providerLabel: "Groq",
});

// Smallest/cheapest tier ($0.075/$0.30 per MTok) — quick everyday text.
export const gptOss20bAdapter = createOpenAICompatibleAdapter({
  id: "groq:gpt-oss-20b",
  model: "openai/gpt-oss-20b",
  baseURL: "https://api.groq.com/openai/v1",
  providerKeyId: "groq",
  providerLabel: "Groq",
});
