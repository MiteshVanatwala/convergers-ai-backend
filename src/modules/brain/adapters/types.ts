import type { RouteRequest } from "@convergers-ai/shared-types";
import type { TokenUsage } from "./pricing";

/**
 * What adapters actually receive: the public RouteRequest plus Brain-internal
 * fields, set only by the Brain itself (client-supplied values are stripped
 * in brain/index.ts):
 * - `systemNote` is appended to the adapter's system prompt.
 * - `maxOutputTokens` lowers the adapter's output cap — the router sets it to
 *   what the account's credit balance can pay for (router/credits.ts).
 */
export type BrainRequest = RouteRequest & {
  systemNote?: string;
  maxOutputTokens?: number;
  /** Chat only: let the model put standalone deliverables in <artifact> blocks (see ARTIFACT_GUIDE). */
  enableArtifacts?: boolean;
};

/**
 * How a model creates artifacts in chat. The backend lifts each <artifact>
 * block out of the answer, stores it, and shows it as a card the user can
 * open, share and keep editing (modules/artifacts).
 */
export const ARTIFACT_GUIDE = `Artifacts: when the user asks for a standalone deliverable they will open, reuse or share — a web page or app, an interactive tool, a dashboard, an SVG graphic, icon or illustration, a diagram, or a substantial document (roughly 20+ lines) — put it in an artifact:

<artifact identifier="short-kebab-case-id" type="html" title="Short title">
...complete content...
</artifact>

- type is one of: html (a complete standalone HTML document; inline CSS and JS; scripts only from cdnjs.cloudflare.com or cdn.jsdelivr.net), react (one component file with a default export; only React is available, use Tailwind classes for styling, no other imports), svg (a single <svg> element), mermaid (Mermaid diagram source), markdown (a formatted document), code (a long code file; add language="python" etc.).
- Write one or two sentences before the artifact saying what you made. Never put the artifact inside a code fence.
- To change an existing artifact, reuse its identifier and output the complete new version — never a partial diff.
- Don't use artifacts for short snippets, quick answers, explanations or conversation.`;

export function withSystemNote(basePrompt: string, request: RouteRequest): string {
  const brain = request as BrainRequest;
  const parts = [basePrompt];
  if (brain.enableArtifacts) parts.push(ARTIFACT_GUIDE);
  if (brain.systemNote) parts.push(brain.systemNote);
  return parts.join("\n\n");
}

/** The adapter's own cap, lowered to the Brain's `maxOutputTokens` when that's smaller. */
export function outputTokenLimit(adapterMax: number, request: RouteRequest): number {
  const requested = (request as BrainRequest).maxOutputTokens;
  return requested !== undefined ? Math.min(adapterMax, requested) : adapterMax;
}

/** How an adapter is priced — lets the router check affordability before calling it. */
export type AdapterCost =
  | { kind: "tokens"; model: string; maxOutputTokens: number }
  | { kind: "flat"; usd: number };

export interface ProviderResponse {
  content: string;
  usage: TokenUsage;
  native_cost: number;
  /** Stopped at the output-token limit (Anthropic "max_tokens", OpenAI-style "length"). */
  truncated?: boolean;
  /** The caller aborted mid-stream — `content` is what arrived before that, and `usage` is estimated. */
  stopped?: boolean;
}

/**
 * Output tokens for a stream cut short by the caller. Providers only report
 * usage when a stream completes, so a stopped one is billed on this estimate
 * (~4 chars/token, the usual English average).
 */
export function estimateOutputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One adapter per provider — this is the only shape the router depends on. */
export interface ProviderAdapter {
  id: string;
  /** provider_credentials id this adapter authenticates with — decides own key (BYOK) vs master key. */
  keyProviderId: string;
  cost: AdapterCost;
  /**
   * False when this model can't do what the request asks (e.g. an animated
   * GIF from a still-image model). Auto routing skips it; an explicit pick
   * is still honored. Omitted means "can handle anything of its task type".
   */
  canHandle?(request: RouteRequest): boolean;
  /**
   * Typical USD for one request, when `cost` alone misleads — e.g. Claude
   * images bill per token but run many sandbox steps. Used to rank models
   * cheapest-first in test mode.
   */
  typicalUsd?: number;
  /**
   * `accountId` drives per-account key resolution (own key vs. master key,
   * tier-gated — see accountKeyResolver.ts). `null` is for internal calls
   * not attributed to any end user, which always use the master key.
   */
  call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse>;
  /**
   * Same call, but invokes `onDelta` with each text chunk as it arrives.
   * `onInputTokens`, when provided, fires as soon as the provider reports an
   * exact prompt token count — only Anthropic's stream exposes this ahead of
   * completion (its `message_start` event); adapters that can't know this
   * early just never call it.
   * When `signal` aborts, a text adapter cancels the provider call and
   * resolves with what it has so far, marked `stopped` (never rejects for it).
   * Adapters with nothing to stream (images) may ignore it.
   */
  streamCall(
    request: RouteRequest,
    onDelta: (text: string) => void,
    accountId: string | null,
    onInputTokens?: (tokens: number) => void,
    signal?: AbortSignal
  ): Promise<ProviderResponse>;
}
