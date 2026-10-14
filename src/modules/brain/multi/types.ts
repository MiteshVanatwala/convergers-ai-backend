import type { AnswerMetadata, RouteResponse } from "@convergers-ai/shared-types";
import type { BrainRequest } from "../adapters/types";
import type { RouteUsageContext, StageEvent } from "../router";

/** A chat answer from any mode, plus every usage_events row it was billed through. */
export type ChatResult = RouteResponse & { usageEventIds: string[] };

export type MultiCallbacks = {
  /** The visible answer as it streams (the chair's verdict, the report…). */
  onDelta: (text: string) => void;
  onStage?: (event: StageEvent) => void;
  ctx?: RouteUsageContext;
  signal?: AbortSignal;
};

/** Adds up what every call in a multi-model answer used and cost. */
export class Tally {
  credits = 0;
  inputTokens = 0;
  outputTokens = 0;
  nativeCost = 0;
  usageEventIds: string[] = [];

  add(r: { credits: number; inputTokens: number; outputTokens: number; nativeCost: number; usageEventId?: string | null }) {
    this.credits += r.credits;
    this.inputTokens += r.inputTokens;
    this.outputTokens += r.outputTokens;
    this.nativeCost += r.nativeCost;
    if (r.usageEventId) this.usageEventIds.push(r.usageEventId);
  }

  addResponse(r: RouteResponse) {
    this.add({
      credits: r.credits_charged,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      nativeCost: r.native_cost,
      usageEventId: r.usage_event_id,
    });
  }

  result(providerUsed: string, content: string, metadata: AnswerMetadata, extra: Partial<RouteResponse> = {}): ChatResult {
    return {
      provider_used: providerUsed,
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      native_cost: this.nativeCost,
      credits_charged: this.credits,
      content,
      fallback_used: false,
      metadata,
      usageEventIds: this.usageEventIds,
      ...extra,
    };
  }
}

/** Member calls: no artifact blocks — their text is read by another model, not shown as cards. */
export function withoutArtifacts(request: BrainRequest): BrainRequest {
  const { enableArtifacts: _artifacts, ...rest } = request;
  return rest;
}

/** Model A, Model B, … — anonymous so the chair doesn't favour its own family. */
export function memberName(index: number): string {
  return `Model ${String.fromCharCode(65 + index)}`;
}

export function quote(text: string): string {
  return `"""\n${text.trim()}\n"""`;
}
