import OpenAI from "openai";
import type { AnswerSource } from "@convergers-ai/shared-types";
import { hasOwnKey, resolveKeyForAccount } from "../adapters/accountKeyResolver";
import { nativeCost, type TokenUsage } from "../adapters/pricing";
import { creditsForCost } from "../../ledger/ledger.service";
import * as usageService from "../../usage/usage.service";

/**
 * Web search for answers that need current facts. Groq's built-in browser
 * tool on gpt-oss searches (Exa under the hood) and reads pages server-side
 * in one call; the model returns findings tagged with the URL each came
 * from, which become numbered sources the answering model cites as [n].
 * https://console.groq.com/docs/browser-search
 *
 * Left to itself the tool loop can run long (one test: 5 searches, 3 pages,
 * 346K prompt tokens, 29 s), so the prompt caps searches and pages and the
 * call has a timeout. Billed like any model call: tokens plus Groq's
 * per-search / per-page fees, on the account's own Groq key when it has one.
 */

/** Runs on the gpt-oss-20b registry row: same key and plan access. */
const KEY_REGISTRY_ID = "groq:gpt-oss-20b";
const MODEL = "openai/gpt-oss-20b";
/** usage_events.provider for search calls (not a chat model, so not in provider_registry). */
export const SEARCH_PROVIDER_ID = "groq:browser-search";
const BASE_URL = "https://api.groq.com/openai/v1";
/** groq.com/pricing, built-in tools (GPT-OSS): $5 / 1,000 searches, $1 / 1,000 pages visited. */
const USD_PER_SEARCH = 0.005;
const USD_PER_PAGE = 0.001;
/** Charged per search on the account's own Groq key (Groq bills them directly). */
const BYOK_SEARCH_CREDITS = 1;
const TIMEOUT_MS = 60_000;
/** Groq's per-minute limits: wait this long (or its retry-after, if shorter) and retry once. */
const RATE_LIMIT_RETRY_MS = 5_000;
const MAX_OUTPUT_TOKENS = 3000;

export type SearchDepth = "quick" | "thorough";

const LIMITS: Record<SearchDepth, { searches: number; pages: number; findings: string }> = {
  quick: { searches: 2, pages: 2, findings: "4–8" },
  // Each page read is re-sent on every tool step, so pages drive the cost (3 searches + 3 pages ran 18–36 credits).
  thorough: { searches: 2, pages: 3, findings: "6–12" },
};

export type WebResearch = {
  /** Bullet findings, each ending in its [n] citation(s). */
  notes: string;
  sources: AnswerSource[];
  creditsCharged: number;
  nativeCost: number;
  inputTokens: number;
  outputTokens: number;
  usageEventId: string | null;
};

type ExecutedTool = {
  name?: string;
  search_results?: { results?: { title?: string; url?: string }[] };
};

function systemPrompt(depth: SearchDepth): string {
  const limit = LIMITS[depth];
  const today = new Date().toISOString().slice(0, 10);
  return `You are a web researcher gathering facts for another AI, which will write the final answer. Today is ${today}.

Use browser search: at most ${limit.searches} searches, and open at most ${limit.pages} of the most relevant, most authoritative pages. Then stop searching and reply.

Reply with ${limit.findings} bullet-point findings — concrete facts, figures, dates and names that answer the question, newest information first. End every bullet with the full URL it came from in angle brackets, like <https://example.com/page>. If sources disagree or a fact may be out of date, say so in that bullet. No introduction, no conclusion, nothing else.`;
}

/** The search engine's own result pages aren't sources worth citing. */
function citable(url: string): boolean {
  return !/^https?:\/\/(?:www\.)?exa\.ai\/search/i.test(url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Swaps each <url> in the findings for a numbered [n] and builds the matching source list. */
export function numberSources(
  findings: string,
  titles: Map<string, string>
): { notes: string; sources: AnswerSource[] } {
  const sources: AnswerSource[] = [];
  const numbers = new Map<string, number>();
  const notes = findings.replace(/<(https?:\/\/[^>\s]+)>/g, (_match, raw: string) => {
    const url = raw.replace(/[.,;)]+$/, "");
    if (!citable(url)) return "";
    let n = numbers.get(url);
    if (n === undefined) {
      n = sources.length + 1;
      numbers.set(url, n);
      sources.push({ n, title: titles.get(url) || hostOf(url), url });
    }
    return `[${n}]`;
  });
  return { notes: notes.trim(), sources };
}

/**
 * Searches the web for `question` and returns cited findings. `context` is a
 * line or two of earlier conversation so follow-ups ("and in 2024?") search
 * for the right thing. Throws when the search fails; callers decide whether
 * an answer can go ahead without it.
 */
export async function searchWeb(
  question: string,
  accountId: string,
  {
    context,
    depth = "quick",
    conversationId,
    signal,
  }: { context?: string; depth?: SearchDepth; conversationId?: string | null; signal?: AbortSignal } = {}
): Promise<WebResearch> {
  const startedAt = new Date();
  const apiKey = await resolveKeyForAccount(KEY_REGISTRY_ID, "groq", "Groq", accountId);
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  const timeout = AbortSignal.timeout(TIMEOUT_MS);

  const create = () => client.chat.completions.create(
    {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt(depth) },
        { role: "user", content: `${context ? `Conversation so far (for context):\n${context}\n\n` : ""}Question: ${question}` },
      ],
      // Groq's built-in tool; not in the OpenAI SDK's types.
      tools: [{ type: "browser_search" }] as unknown as OpenAI.Chat.ChatCompletionTool[],
      reasoning_effort: "low",
      max_tokens: MAX_OUTPUT_TOKENS,
    },
    { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
  );
  let response: Awaited<ReturnType<typeof create>>;
  try {
    response = await create();
  } catch (err) {
    if (!(err instanceof OpenAI.APIError) || err.status !== 429 || signal?.aborted) throw err;
    const retryAfter = Number(err.headers?.get?.("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, RATE_LIMIT_RETRY_MS) : RATE_LIMIT_RETRY_MS;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await create();
  }

  const message = response.choices[0]?.message as (OpenAI.Chat.ChatCompletionMessage & {
    executed_tools?: ExecutedTool[];
  }) | undefined;
  const tools = message?.executed_tools ?? [];
  const titles = new Map<string, string>();
  for (const tool of tools) {
    for (const result of tool.search_results?.results ?? []) {
      if (result.url && result.title && !titles.has(result.url)) titles.set(result.url, result.title);
    }
  }
  const { notes, sources } = numberSources(message?.content ?? "", titles);
  if (!notes) throw new Error("Web search returned no findings");

  const searches = tools.filter((t) => t.name === "browser.search").length;
  const pages = tools.filter((t) => t.name === "browser.open").length;
  const u = response.usage;
  const usage: TokenUsage = {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: Math.max(u?.completion_tokens ?? 0, (u?.total_tokens ?? 0) - (u?.prompt_tokens ?? 0)),
    cached_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
  };
  const cost = nativeCost(MODEL, usage, startedAt) + searches * USD_PER_SEARCH + pages * USD_PER_PAGE;
  const byok = await hasOwnKey("groq", accountId);

  const { charged, usageEventId } = await usageService.recordSuccessAndDebit({
    accountId,
    conversationId,
    taskType: "research",
    provider: SEARCH_PROVIDER_ID,
    tokensInput: usage.input_tokens,
    tokensOutput: usage.output_tokens,
    nativeCost: cost,
    creditsRequested: byok ? BYOK_SEARCH_CREDITS : creditsForCost(cost),
    fallbackUsed: false,
  });

  return {
    notes,
    sources,
    creditsCharged: charged,
    nativeCost: cost,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    usageEventId,
  };
}

/** What the answering model is told about the research (appended to its system prompt). */
export function researchNote(notes: string, sources: AnswerSource[]): string {
  const list = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");
  return `Web research gathered just now for the user's latest message:
${notes}

Sources:
${list || "(none)"}

Use these findings where they're relevant and cite them inline as [n] right after the claim they support, e.g. "… launched in 2025 [2]." Only cite numbers from this list. If the findings don't cover something, say so rather than guessing. Don't add a sources or references list at the end — it's shown separately.`;
}

/**
 * Turns [n] citations into links ([[2]](url)) so they work in the stored
 * answer too. Code blocks are left alone, as is any [n] with no matching source.
 */
export function linkCitations(content: string, sources: AnswerSource[]): string {
  if (sources.length === 0) return content;
  const byNumber = new Map(sources.map((s) => [s.n, s.url]));
  return content
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[(\d{1,3})\](?!\()/g, (match, n: string) => {
            const url = byNumber.get(Number(n));
            return url ? `[[${n}]](${url})` : match;
          })
    )
    .join("");
}

/** Merges several searches' sources into one list, renumbering each one's [n] citations. */
export function mergeResearch(results: { notes: string; sources: AnswerSource[] }[]): {
  notes: string[];
  sources: AnswerSource[];
} {
  const sources: AnswerSource[] = [];
  const byUrl = new Map<string, number>();
  const notes = results.map((r) => {
    const remap = new Map<number, number>();
    for (const s of r.sources) {
      let n = byUrl.get(s.url);
      if (n === undefined) {
        n = sources.length + 1;
        byUrl.set(s.url, n);
        sources.push({ ...s, n });
      }
      remap.set(s.n, n);
    }
    return r.notes.replace(/\[(\d{1,3})\]/g, (match, n: string) => {
      const mapped = remap.get(Number(n));
      return mapped ? `[${mapped}]` : match;
    });
  });
  return { notes, sources };
}
