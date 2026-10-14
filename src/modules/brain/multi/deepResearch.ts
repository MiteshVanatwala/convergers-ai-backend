import { randomUUID } from "node:crypto";
import type { BrainRequest, ProviderAdapter } from "../adapters/types";
import { RequestStoppedError, UserFacingError } from "../router/errors";
import { multiModelCandidates, routeWithAdapter } from "../router";
import { linkCitations, mergeResearch, researchNote, searchWeb, type WebResearch } from "../search/webSearch";
import { Tally, quote, withoutArtifacts, type ChatResult, type MultiCallbacks } from "./types";

/**
 * Deep Research, streamed in the chat: a planner splits the question into
 * focused sub-questions, each is researched on the web in turn,
 * and a writer turns the findings into a cited report, delivered as a
 * markdown artifact (modules/artifacts) the user can open, keep and share.
 *
 * Bounded so a run stays affordable and finishes in a couple of minutes:
 * at most MAX_STEPS research steps, each capped at 2 searches / 3 pages
 * (search/webSearch.ts "thorough"). Every call is billed as it happens;
 * Stop aborts the run between (and during streamed) steps.
 */

const MAX_STEPS = 5;
/** One at a time: parallel browser searches tripped Groq's per-minute token limit (3 of 5 failed in testing). */
const SEARCH_CONCURRENCY = 1;

const PLAN_PROMPT = (question: string) => `Plan web research for the question below. Break it into 3 to ${MAX_STEPS} focused sub-questions that, answered together, fully answer it — each specific enough to search for on its own (include names, places, time frames). Cover the main angles: facts and current state, causes or drivers, comparisons or alternatives, risks or open questions — whichever apply.

Reply with a JSON array of strings only, nothing else.

Question:
${quote(question)}`;

const REPORT_PROMPT = (question: string) => `Write a thorough, well-structured research report in Markdown that answers the user's question, using the web research in your instructions.

- Start with a "# " title, then a short executive summary (3–5 sentences).
- Then sections with "## " headings covering each part of the question, with specifics: numbers, dates, names.
- Cite every factual claim inline as [n] using the source numbers given. Never invent a citation.
- Where sources disagree or information is thin or possibly outdated, say so.
- End with "## Key takeaways" (bullets) and "## Open questions" (what the research couldn't settle).
- No references list — sources are listed separately.
- Aim for 900–1,800 words; shorter if the question is narrow.

The user's question:
${quote(question)}`;

function parsePlan(text: string, fallback: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const steps = JSON.parse(match[0]) as unknown;
      if (Array.isArray(steps)) {
        const clean = steps
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, MAX_STEPS);
        if (clean.length > 0) return clean;
      }
    } catch {
      // fall through to the question itself
    }
  }
  return [fallback];
}

/** Runs `work` over `items`, at most `limit` at a time, keeping results in order. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!, index);
      }
    })
  );
  return results;
}

/** Tries each model in turn until one succeeds. */
async function firstThatWorks<R>(
  models: ProviderAdapter[],
  signal: AbortSignal | undefined,
  run: (model: ProviderAdapter) => Promise<R>
): Promise<R> {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await run(model);
    } catch (err) {
      if (err instanceof RequestStoppedError || signal?.aborted) throw new RequestStoppedError();
      lastError = err;
    }
  }
  throw lastError ?? new UserFacingError("No model is available for research right now.");
}

function artifactTitle(question: string): string {
  const clean = question.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return clean.length > 70 ? `${clean.slice(0, 69)}…` : clean;
}

export async function runDeepResearch(
  request: BrainRequest,
  accountId: string,
  cb: MultiCallbacks,
  tally: Tally
): Promise<ChatResult> {
  const models = await multiModelCandidates(request, "research", accountId, cb.ctx);
  if (models.length === 0) throw new UserFacingError("No model is available for research right now.");
  const plain = withoutArtifacts(request);

  // 1) Plan.
  const planRequest: BrainRequest = { ...plain, input: PLAN_PROMPT(request.input), effort: "standard" };
  const plan = await firstThatWorks(models, cb.signal, async (model) => {
    const reply = await routeWithAdapter(
      model,
      planRequest,
      "research",
      accountId,
      cb.ctx,
      { signal: cb.signal }
    );
    tally.addResponse(reply);
    return parsePlan(reply.content, request.input);
  });
  cb.onStage?.({ stage: "plan", steps: plan });

  // 2) Research each step.
  const findings = await inBatches(plan, SEARCH_CONCURRENCY, async (step): Promise<WebResearch | null> => {
    if (cb.signal?.aborted) throw new RequestStoppedError();
    cb.onStage?.({ stage: "search", status: "start", query: step });
    try {
      const research = await searchWeb(step, accountId, {
        context: `Overall research question: ${request.input}`,
        depth: "thorough",
        conversationId: cb.ctx?.conversationId,
        signal: cb.signal,
      });
      tally.add({
        credits: research.creditsCharged,
        inputTokens: research.inputTokens,
        outputTokens: research.outputTokens,
        nativeCost: research.nativeCost,
        usageEventId: research.usageEventId,
      });
      cb.onStage?.({ stage: "search", status: "done", query: step, sources: research.sources.length });
      return research;
    } catch (err) {
      if (cb.signal?.aborted) throw new RequestStoppedError();
      cb.onStage?.({ stage: "search", status: "failed", query: step });
      return null;
    }
  });
  const found = findings.filter((f): f is WebResearch => f !== null);
  if (found.length === 0) {
    throw new UserFacingError("Web search isn't working right now, so the research couldn't run. Please try again later.");
  }
  const merged = mergeResearch(found);
  const notes = plan
    .map((step, i) => (findings[i] ? `### ${step}\n${merged.notes[found.indexOf(findings[i]!)]}` : null))
    .filter(Boolean)
    .join("\n\n");

  // 3) Write the report, streamed inside an artifact block.
  const title = artifactTitle(request.input);
  const open = `<artifact identifier="research-${randomUUID().slice(0, 8)}" type="markdown" title="Research: ${title}">\n`;
  const close = "\n</artifact>";
  const intro = `Here's the research report — ${found.length} research step${found.length === 1 ? "" : "s"}, ${merged.sources.length} source${merged.sources.length === 1 ? "" : "s"}.\n\n`;
  const writerRequest: BrainRequest = {
    ...plain,
    input: REPORT_PROMPT(request.input),
    effort: "deep",
    systemNote: [plain.systemNote, researchNote(notes, merged.sources)].filter(Boolean).join("\n\n"),
  };

  return firstThatWorks(models, cb.signal, async (model) => {
    cb.onStage?.({ stage: "writing", provider: model.id });
    let started = false;
    const report = await routeWithAdapter(model, writerRequest, "research", accountId, cb.ctx, {
      signal: cb.signal,
      onDelta: (text) => {
        if (!started) {
          started = true;
          cb.onDelta(intro + open);
        }
        cb.onDelta(text);
      },
    });
    tally.addResponse(report);
    if (started) cb.onDelta(close);
    const content = `${intro}${open}${linkCitations(report.content.trim(), merged.sources)}${close}`;
    return tally.result(
      model.id,
      content,
      { mode: "deep_research", plan, sources: merged.sources },
      {
        ...(report.truncated ? { truncated: true } : {}),
        ...(report.stopped ? { stopped: true } : {}),
      }
    );
  });
}
