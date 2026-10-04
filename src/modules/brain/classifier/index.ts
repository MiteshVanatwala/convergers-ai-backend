import type { RouteRequest } from "@convergers-ai/shared-types";
import { classifyWithModel } from "./model";

export type TaskType = "text" | "code" | "image" | "voice" | "video" | "research" | "plan" | "artifact";

const CODE_SIGNS = /```|\bfunction\b|=>|\bclass \w+|\bimport .+ from\b|\bdef \w+\(/;

// Plain-English programming requests with no code in them ("programmatically
// create a dashboard", "write a python script", "fix this bug"). "program"
// alone is excluded (TV/event programmes); its derivations — including
// common misspellings like "programetically" — are not.
const CODE_INTENT_SIGNS = new RegExp(
  [
    String.raw`\bprogram(?!s?\b|mes?\b)\w+`,
    String.raw`\b(?:coding|codebase|source code|write (?:the |some |a )?code|in code)\b`,
    String.raw`\b(?:script|snippet|refactor\w*|debug\w*|compil\w+|stack ?trace|regex|unit tests?|api endpoint|rest api|sdk)\b`,
    String.raw`\b(?:python|javascript|typescript|java|kotlin|swift|golang|rust|c\+\+|c#|php|ruby|sql|bash|react|next\.?js|node\.?js|vue|angular|django|flask|fastapi|spring boot|html|css|tailwind)\b`,
  ].join("|"),
  "i"
);

// "generate an image of X", "draw a cat", "design a logo for..." — an action
// verb followed closely by a visual-media noun. Deliberately narrow: it's
// meant to catch generation requests, not every sentence that mentions the
// word "image" (e.g. "explain how image compression works" shouldn't match).
const IMAGE_GEN_SIGNS = /\b(generate|create|draw|paint|make|design|produce|render)\b.{0,20}\b(image|picture|photo|illustration|drawing|painting|artwork|logo|icon|wallpaper|poster|gifs?|animated (?:gif|image|logo|banner|sticker|emoji|icon|text))\b/i;

// "a photo of a red fox in snow" — a bare image description, no verb — or
// "draw a cat" / "sketch a castle" (but not "draw a flowchart", an artifact).
const IMAGE_DESCRIPTION = /^\s*(?:(?:an?\s+)?(?:image|picture|photo|illustration|painting|drawing|sketch|watercolou?r|portrait)\s+of\b|(?:please\s+)?(?:draw|paint|sketch|illustrate)\b(?!.{0,30}\b(?:diagram|flow ?chart|chart|graph|mind ?map|org chart|table|svg)\b))/i;

// After an image answer: "now make the sky orange", "add a hat", "try again"
// — a short instruction that edits the image rather than starting a new topic.
const IMAGE_EDIT_SIGNS = /^\s*(?:(?:now|ok(?:ay)?|great|nice|cool|good|and|also|please|can you|could you|pls)[\s,!.]+)*(?:make|change|turn|add|remove|erase|replace|put|give|use|recolou?r|colou?r|zoom|crop|extend|try|redo|regenerate|another|again|same|without|with|more|less|but|swap|move|edit)\b/i;
const GENERATED_IMAGE = /!\[[^\]]*\]\(\/v1\/files\/[0-9a-f-]{36}\)/;

/** True when the latest assistant answer is a generated image and this input reads like an edit of it. */
function isImageFollowUp(request: RouteRequest): boolean {
  const last = [...(request.history ?? [])].reverse().find((turn) => turn.role === "assistant");
  return Boolean(last && GENERATED_IMAGE.test(last.content) && request.input.length <= 400 && IMAGE_EDIT_SIGNS.test(request.input));
}

// "build a landing page", "make an interactive dashboard", "create an SVG
// diagram", "write a one-page document" — a standalone deliverable the user
// will open, reuse or share (an artifact), which routes to Claude first.
const ARTIFACT_SIGNS = new RegExp(
  String.raw`\b(build|create|make|design|draw|generate|write|draft|prototype|mock ?up)\b.{0,30}\b(` +
    [
      "landing page",
      "web ?page",
      "website",
      "web app",
      "single[- ]page app",
      "html page",
      "dashboard",
      "interactive",
      "game",
      "calculator",
      "widget",
      "svg",
      "diagram",
      "flow ?chart",
      "mind ?map",
      "org chart",
      "infographic",
      "slide ?deck",
      "presentation",
      "one[- ]pager",
      "resume",
      "cv",
      "react component",
    ].join("|") +
    String.raw`)\b`,
  "i"
);

// "create a project plan", "roadmap for...", "plan my week" — planning and
// strategy requests, which route to a stronger reasoning model (see router).
const PLAN_SIGNS = /\broadmap\b|\b(project|action|strategic|business)\s+plan\b|\bplan\b\s+(for|to|my|our|a|an|the)\b/i;

/** How a request's task type was decided — surfaced to the client in the "classify" stage. */
export type ClassificationMethod = "hint" | "rules" | "model" | "default";

export type Classification = { taskType: TaskType; method: ClassificationMethod };

/**
 * The rules pass: returns a task type only when a pattern is confident,
 * null when the request is ambiguous and should go to the model.
 */
export function classifyByRules(request: RouteRequest): TaskType | null {
  // Saying "artifact" is an explicit ask for one ("make an artifact of our logo").
  if (/\bartifacts?\b/i.test(request.input)) return "artifact";
  if (IMAGE_GEN_SIGNS.test(request.input) || IMAGE_DESCRIPTION.test(request.input)) return "image";
  if (isImageFollowUp(request)) return "image";
  if (ARTIFACT_SIGNS.test(request.input)) return "artifact";
  if (PLAN_SIGNS.test(request.input)) return "plan";
  if (CODE_SIGNS.test(request.input) || CODE_INTENT_SIGNS.test(request.input)) return "code";
  return null;
}

/**
 * Hybrid classifier per the technical plan §03: an explicit modality hint
 * wins; then a cheap rules pass catches obvious cases; ambiguous requests go
 * to a small model (classifier/model.ts). If the model is slow or fails, the
 * request falls back to "text" — the same answer the rules-only version gave.
 */
export async function classifyRequest(request: RouteRequest): Promise<Classification> {
  if (request.modality_hint) return { taskType: request.modality_hint as TaskType, method: "hint" };

  const byRules = classifyByRules(request);
  if (byRules) return { taskType: byRules, method: "rules" };

  const byModel = await classifyWithModel(request);
  if (byModel) return { taskType: byModel, method: "model" };

  return { taskType: "text", method: "default" };
}
