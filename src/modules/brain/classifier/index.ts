import type { RouteRequest } from "@convergers-ai/shared-types";
import { classifyWithModel } from "./model";

export type TaskType =
  | "text"
  | "code"
  | "image"
  | "voice"
  | "video"
  | "research"
  | "plan"
  | "artifact"
  | "math"
  | "reasoning"
  | "writing"
  | "translation";

/**
 * Text-answer domains that get their own Auto chain, so each can lead with
 * the models best at it. Until an admin configures one, it uses the "text"
 * chain (router/index.ts) — nothing breaks for a domain with no rows yet.
 */
export const TEXT_DOMAINS: readonly TaskType[] = ["math", "reasoning", "writing", "translation"];

/**
 * How hard the model should think. Adapters map it onto each provider's own
 * reasoning control (adapters/reasoning.ts): "quick" turns reasoning down or
 * off (greetings, one-line facts), "deep" turns it up (proofs, multi-step
 * maths, tricky logic), "standard" leaves the provider's default — except
 * where that default is needlessly high.
 */
export type Effort = "quick" | "standard" | "deep";

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

// After an image answer: "now make the sky orange", "add a hat", "try again
// but brighter" — an edit of that image, not a new topic. Needs an edit verb
// up front AND either something visual to point at ("it", "the background",
// "colours") or a very short instruction ("add a red hat"). Plain follow-up
// questions ("can you give me a greeting message") stay with the text models.
const IMAGE_EDIT_START = /^\s*(?:(?:now|ok(?:ay)?|great|nice|cool|good|and|also|please|pls|can you|could you)[\s,!.]+)*(?:make|change|turn|add|remove|erase|replace|put|recolou?r|colou?r|zoom|crop|extend|redo|regenerate|swap|move|edit|try again|do it again|another one|give it|use (?:a|an|the|more|less)|without|darker|brighter|bigger|smaller)\b/i;
const IMAGE_EDIT_TARGET = /\b(?:it|this|that|image|picture|photo|gif|animation|logo|icon|background|colou?rs?|text|font|letters?|words?|sky|style|version|frames?|border|size|lighting|shadow|glow|speed)\b/i;
const GENERATED_IMAGE = /!\[[^\]]*\]\(\/v1\/files\/[0-9a-f-]{36}\)/;

/** True when the latest assistant answer is a generated image and this input reads like an edit of it. */
function isImageFollowUp(request: RouteRequest): boolean {
  const last = [...(request.history ?? [])].reverse().find((turn) => turn.role === "assistant");
  if (!last || !GENERATED_IMAGE.test(last.content) || request.input.length > 400) return false;
  if (!IMAGE_EDIT_START.test(request.input)) return false;
  const words = request.input.trim().split(/\s+/).length;
  return IMAGE_EDIT_TARGET.test(request.input) || words <= 4;
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

// "solve 2x + 3 = 7", "integral of x^2", "prove that √2 is irrational",
// LaTeX. Deliberately conservative — ambiguous ones ("what's the
// probability it rains") go to the model.
const MATH_SIGNS = new RegExp(
  [
    String.raw`\b(?:solve|simplify|factori[sz]e|integrate|differentiate|evaluate|expand)\b.{0,40}(?:[=^√∫²³]|\d\s*[a-z]\b|\bequations?\b|\bfor [a-z]\b)`,
    String.raw`\b(?:integral of|derivative of|eigen(?:values?|vectors?)|determinant of|differential equations?|quadratic equations?|polynomials?|trigonometr\w*|logarithms?|calculus|theorem|lemma|prove that|proof that|probability (?:that|of)|permutations? of|n ?choose ?k)\b`,
    String.raw`\\(?:frac|int|sum|sqrt|lim|binom)\b`,
    String.raw`\b\d*[a-z]\s*\^\s*\d|\b\d+[a-z]\s*[+\-=]\s*\d`,
  ].join("|"),
  "i"
);

// Riddles and logic puzzles — not "recommend puzzle games".
const REASONING_SIGNS = /\b(?:riddle|brain ?teasers?|logic(?:al)? puzzles?|syllogisms?|lateral thinking)\b/i;

// "translate this into Hindi" — a natural language as the target, so
// "translate this Python to Go" stays with code.
const TRANSLATION_SIGNS = new RegExp(
  String.raw`\btranslat\w*\b.{0,80}\b(?:to|into|in)\s+(?:` +
    [
      "english", "hindi", "marathi", "gujarati", "bengali", "bangla", "tamil", "telugu", "kannada",
      "malayalam", "punjabi", "odia", "urdu", "sanskrit", "nepali", "french", "spanish", "german",
      "italian", "portuguese", "dutch", "russian", "arabic", "persian", "turkish", "chinese",
      "mandarin", "japanese", "korean", "thai", "vietnamese", "indonesian", "malay", "swahili",
    ].join("|") +
    String.raw`)\b`,
  "i"
);

// "write an email to my landlord", "draft a cover letter", "compose a poem"
// — prose where tone and style matter. Checked before code so "a cover
// letter for a Python developer role" isn't sent to a coding model.
const WRITING_SIGNS = /^\s*(?:(?:please|pls|can you|could you|help me)\s+)?(?:write|draft|compose|pen)\b.{0,40}\b(?:e-?mail|letter|cover letter|essay|poem|story|short story|blog post|article|speech|caption|tweet|linkedin post|bio|toast|eulogy|lyrics|song|script for|wedding|invitation|apology|announcement|newsletter)\b/i;

const QUICK_SIGNS = /^\s*(?:hi|hii+|hello|hey|yo|thanks?|thank you|thx|ok(?:ay)?|cool|great|nice|good (?:morning|afternoon|evening|night)|bye|yes|no|sure|got it)\b[\s!.?,]*$/i;
const DEEP_SIGNS = /\b(?:step[- ]by[- ]step|think (?:hard|carefully|deeply)|in depth|rigorous(?:ly)?|prove|proof|derive|show (?:your|the) work|edge cases)\b/i;
const TEXT_ANSWER_TYPES = new Set<TaskType>(["text", "code", "research", "plan", "artifact", ...TEXT_DOMAINS]);

/**
 * Effort when the rules (or a hint) decided the task type and no model was
 * asked: maths and logic think hard, small talk and translation don't.
 */
export function estimateEffort(request: RouteRequest, taskType: TaskType): Effort {
  if (!TEXT_ANSWER_TYPES.has(taskType)) return "standard";
  const input = request.input.trim();
  if (QUICK_SIGNS.test(input)) return "quick";
  if (taskType === "math" || taskType === "reasoning" || DEEP_SIGNS.test(input)) return "deep";
  if (taskType === "translation") return "quick";
  if (taskType === "text" && input.length <= 40 && !request.history?.length) return "quick";
  return "standard";
}

/** How a request's task type was decided — surfaced to the client in the "classify" stage. */
export type ClassificationMethod = "hint" | "rules" | "model" | "default";

export type Classification = { taskType: TaskType; method: ClassificationMethod; effort: Effort };

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
  if (TRANSLATION_SIGNS.test(request.input)) return "translation";
  if (WRITING_SIGNS.test(request.input)) return "writing";
  if (CODE_SIGNS.test(request.input) || CODE_INTENT_SIGNS.test(request.input)) return "code";
  if (MATH_SIGNS.test(request.input)) return "math";
  if (REASONING_SIGNS.test(request.input)) return "reasoning";
  return null;
}

/**
 * Hybrid classifier per the technical plan §03: an explicit modality hint
 * wins; then a cheap rules pass catches obvious cases; ambiguous requests go
 * to a small model (classifier/model.ts). If the model is slow or fails, the
 * request falls back to "text" — the same answer the rules-only version gave.
 */
export async function classifyRequest(request: RouteRequest): Promise<Classification> {
  // A spoken request (voice mode) is still answered in text — classify what was said.
  const hint = request.modality_hint === "voice" ? undefined : request.modality_hint;
  if (hint) {
    const taskType = hint as TaskType;
    return { taskType, method: "hint", effort: estimateEffort(request, taskType) };
  }

  const byRules = classifyByRules(request);
  if (byRules) return { taskType: byRules, method: "rules", effort: estimateEffort(request, byRules) };

  const byModel = await classifyWithModel(request);
  if (byModel) {
    return {
      taskType: byModel.taskType,
      method: "model",
      effort: byModel.effort ?? estimateEffort(request, byModel.taskType),
    };
  }

  return { taskType: "text", method: "default", effort: estimateEffort(request, "text") };
}
