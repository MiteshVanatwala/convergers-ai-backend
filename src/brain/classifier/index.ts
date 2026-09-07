import type { RouteRequest } from "@convergers-ai/shared-types";

export type TaskType = "text" | "code" | "image" | "voice" | "video" | "research";

/**
 * Hybrid classifier per the technical plan §03: a cheap rules pass catches
 * obvious cases; ambiguous requests fall through to a small model. This is
 * the rules pass only — the model fallback is not wired up yet.
 */
export async function classify(request: RouteRequest): Promise<TaskType> {
  if (request.modality_hint) return request.modality_hint as TaskType;
  return "text";
}
