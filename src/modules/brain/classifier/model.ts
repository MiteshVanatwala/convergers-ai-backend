import type { RouteRequest } from "@convergers-ai/shared-types";
import { haikuAdapter } from "../adapters/anthropic";
import { deepseekFlashAdapter } from "../adapters/deepseek";
import { gptOssAdapter } from "../adapters/gptOss";
import type { BrainRequest, ProviderAdapter } from "../adapters/types";
import type { TaskType } from "./index";

/**
 * The model half of the hybrid classifier: only consulted when the rules
 * pass isn't confident. Fast/cheap models first; like the rest of the Brain's
 * internal calls it runs on the master key (accountId null) and isn't billed
 * to the user — it's a few hundred tokens, a fraction of a credit.
 */
const CLASSIFIER_CHAIN: ProviderAdapter[] = [haikuAdapter, deepseekFlashAdapter, gptOssAdapter];

/** Past this, routing waits on the classifier longer than it saves — use the rules default. */
const CLASSIFIER_TIMEOUT_MS = 2500;

/** Only categories with a configured model chain — never voice/video (no providers yet). */
export const MODEL_CLASSIFIABLE: readonly TaskType[] = ["text", "code", "image", "research", "plan", "artifact"];

const MAX_CONTEXT_CHARS = 600;

const PROMPT = `Classify the user's latest request into exactly one category.

artifact — building a standalone thing to open, reuse or share: a web page, app, interactive tool, dashboard, SVG graphic, diagram, or formatted document
code     — writing, explaining, reviewing, or debugging software, scripts, SQL, configs, or building something programmatically
image    — generating or editing a picture, illustration, logo, or other visual
research — investigating a topic in depth: comparing options, analysing markets, trends, studies, or pros and cons
plan     — making a plan, roadmap, schedule, itinerary, or step-by-step strategy
text     — anything else: questions, writing, rewriting, summaries, translation, advice, chat

Use the earlier turns only to understand what the latest request refers to.
Reply with the category word only.`;

function clip(text: string): string {
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text;
}

function buildInput(request: RouteRequest): string {
  // Last two turns are enough to resolve "I mean programmatically…"-style follow-ups.
  const recent = (request.history ?? []).slice(-2);
  const context = recent.length
    ? `Earlier turns:\n${recent.map((t) => `${t.role}: ${clip(t.content)}`).join("\n")}\n\n`
    : "";
  return `${PROMPT}\n\n${context}Latest request:\n"""\n${clip(request.input)}\n"""`;
}

export function parseCategory(raw: string): TaskType | null {
  const word = raw.trim().toLowerCase().match(/[a-z]+/)?.[0];
  return word && (MODEL_CLASSIFIABLE as readonly string[]).includes(word) ? (word as TaskType) : null;
}

async function callChain(input: string): Promise<TaskType | null> {
  const request: BrainRequest = { input, maxOutputTokens: 5 };
  for (const adapter of CLASSIFIER_CHAIN) {
    try {
      const response = await adapter.call(request, null);
      const category = parseCategory(response.content);
      if (category) return category;
    } catch {
      // Try the next model; the caller falls back to the rules default if none answer.
    }
  }
  return null;
}

/** Returns null if no model answered in time with a valid category. */
export async function classifyWithModel(request: RouteRequest): Promise<TaskType | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CLASSIFIER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([callChain(buildInput(request)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
