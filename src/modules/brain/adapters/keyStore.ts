// Where provider adapters get their API keys from — POC stand-in for a real
// secrets manager. An admin-set key (via the admin panel) takes effect
// immediately for the next request, no restart needed; if nothing's been
// set there, this falls back to the process env var, so a plain .env file
// still works exactly as before for anyone not using the admin panel.

export interface ProviderInfo {
  id: string;
  label: string;
  envVar: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { id: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
  { id: "glm", label: "GLM (Zhipu)", envVar: "GLM_API_KEY" },
  { id: "kimi", label: "Kimi (Moonshot)", envVar: "KIMI_API_KEY" },
  { id: "groq", label: "Groq (Qwen, GPT-OSS)", envVar: "GROQ_API_KEY" },
];

const overrides = new Map<string, string>();

function providerInfo(providerId: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === providerId);
}

export function getKey(providerId: string): string | undefined {
  const override = overrides.get(providerId);
  if (override) return override;
  const provider = providerInfo(providerId);
  return provider ? process.env[provider.envVar] || undefined : undefined;
}

export function setKey(providerId: string, apiKey: string): void {
  overrides.set(providerId, apiKey);
}

export function isConfigured(providerId: string): boolean {
  return Boolean(getKey(providerId));
}

/** Where the currently-active key came from, for the admin UI. */
export function keySource(providerId: string): "override" | "env" | "none" {
  if (overrides.has(providerId)) return "override";
  const provider = providerInfo(providerId);
  if (provider && process.env[provider.envVar]) return "env";
  return "none";
}

/** Never return a raw key over the wire — only ever this. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "••••••••";
  return `${key.slice(0, 6)}${"•".repeat(6)}${key.slice(-4)}`;
}
