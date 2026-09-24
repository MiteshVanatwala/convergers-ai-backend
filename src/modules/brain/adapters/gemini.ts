import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Google's OpenAI-compatible endpoint for Gemini — https://ai.google.dev/gemini-api/docs/openai
export const geminiFlashAdapter = createOpenAICompatibleAdapter({
  id: "gemini:gemini-3.8-flash",
  model: "gemini-3.8-flash",
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  providerKeyId: "gemini",
  providerLabel: "Google Gemini",
});

// Frontier tier — stronger reasoning, larger context.
export const geminiProAdapter = createOpenAICompatibleAdapter({
  id: "gemini:gemini-3.1-pro-preview",
  model: "gemini-3.1-pro-preview",
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  providerKeyId: "gemini",
  providerLabel: "Google Gemini",
});
