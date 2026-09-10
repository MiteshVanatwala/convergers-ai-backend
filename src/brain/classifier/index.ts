import type { RouteRequest } from "@convergers-ai/shared-types";

export type TaskType = "text" | "code" | "image" | "voice" | "video" | "research" | "plan";

const CODE_SIGNS = /```|\bfunction\b|=>|\bclass \w+|\bimport .+ from\b|\bdef \w+\(/;

// "generate an image of X", "draw a cat", "design a logo for..." — an action
// verb followed closely by a visual-media noun. Deliberately narrow: it's
// meant to catch generation requests, not every sentence that mentions the
// word "image" (e.g. "explain how image compression works" shouldn't match).
const IMAGE_GEN_SIGNS = /\b(generate|create|draw|make|design|produce|render)\b.{0,20}\b(image|picture|photo|illustration|drawing|artwork|logo|icon)\b/i;

// "create a project plan", "roadmap for...", "plan my week" — planning and
// strategy requests, which route to a stronger reasoning model (see router).
const PLAN_SIGNS = /\broadmap\b|\b(project|action|strategic|business)\s+plan\b|\bplan\b\s+(for|to|my|our|a|an|the)\b/i;

/**
 * Hybrid classifier per the technical plan §03: a cheap rules pass catches
 * obvious cases; ambiguous requests fall through to a small model. This is
 * the rules pass only — the model fallback is not wired up yet.
 */
export async function classify(request: RouteRequest): Promise<TaskType> {
  if (request.modality_hint) return request.modality_hint as TaskType;
  if (IMAGE_GEN_SIGNS.test(request.input)) return "image";
  if (PLAN_SIGNS.test(request.input)) return "plan";
  if (CODE_SIGNS.test(request.input)) return "code";
  return "text";
}
