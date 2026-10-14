import type { CrossCheck } from "@convergers-ai/shared-types";
import type { TaskType } from "../classifier";
import type { BrainRequest } from "../adapters/types";
import { RequestStoppedError, UserFacingError } from "../router/errors";
import { adapterFor, multiModelCandidates, routeWithAdapter, type RouteUsageContext } from "../router";
import { quote } from "./types";

/**
 * "Cross-check this answer": a model that took no part in the answer (for
 * compare / council / debate, none of the models that answered), preferably
 * from a different family, reviews the answer for factual errors, faulty reasoning and
 * wrong calculations, and gives a verdict plus a corrected answer when needed.
 * One billed call (more only if the first checker fails).
 */

const PROMPT = (question: string, answer: string) => `Check the answer below to the user's question. Look for factual errors, faulty reasoning, wrong calculations and important omissions — recompute any numbers step by step. Be strict but fair: don't nitpick style.

Reply in Markdown, exactly in this shape:
Verdict: Correct | Partly correct | Incorrect | Unclear
## Issues
- each problem, briefly, or "None found."
## Corrected answer
(only when the verdict isn't Correct — the full corrected answer)

The user's question:
${quote(question)}

The answer to check:
${quote(answer)}`;

function parseVerdict(text: string): CrossCheck["verdict"] {
  const match = text.match(/verdict:\s*\**\s*(correct|partly correct|incorrect|unclear)/i);
  switch (match?.[1]?.toLowerCase()) {
    case "correct":
      return "correct";
    case "partly correct":
      return "partly_correct";
    case "incorrect":
      return "incorrect";
    default:
      return "unclear";
  }
}

export async function crossCheck(input: {
  question: string;
  answer: string;
  answerProvider: string | null;
  /** Other models that answered (compare candidates, council / debate members) — never the checker. */
  otherProviders?: string[];
  history: BrainRequest["history"];
  taskType: TaskType;
  accountId: string;
  systemNote?: string;
  ctx?: RouteUsageContext;
}): Promise<{ crosscheck: Omit<CrossCheck, "createdAt">; usageEventId: string | null }> {
  const request: BrainRequest = {
    input: PROMPT(input.question, input.answer),
    ...(input.history?.length ? { history: input.history } : {}),
    ...(input.systemNote ? { systemNote: input.systemNote } : {}),
    effort: "deep",
  };
  const answeredBy = new Set(
    [input.answerProvider, ...(input.otherProviders ?? [])].filter((id): id is string => Boolean(id))
  );
  const families = new Set([...answeredBy].map((id) => adapterFor(id)?.keyProviderId));
  const candidates = (await multiModelCandidates(request, input.taskType, input.accountId, input.ctx)).filter(
    (a) => !answeredBy.has(a.id)
  );
  // A different model family first — the same family tends to repeat the same mistake.
  const ordered = [
    ...candidates.filter((a) => !families.has(a.keyProviderId)),
    ...candidates.filter((a) => families.has(a.keyProviderId)),
  ];
  if (ordered.length === 0) {
    throw new UserFacingError("No other model is available to cross-check this answer right now.");
  }

  // Every option in turn: a provider that's down fails fast and isn't billed.
  let lastError: unknown;
  for (const checker of ordered) {
    try {
      const reply = await routeWithAdapter(checker, request, input.taskType, input.accountId, input.ctx);
      return {
        crosscheck: {
          provider: checker.id,
          verdict: parseVerdict(reply.content),
          content: reply.content.replace(/^\s*verdict:[^\n]*\n?/i, "").trim(),
          credits: reply.credits_charged,
        },
        usageEventId: reply.usage_event_id ?? null,
      };
    } catch (err) {
      if (err instanceof RequestStoppedError) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof UserFacingError
    ? lastError
    : new UserFacingError("Couldn't cross-check this answer right now. Please try again shortly.");
}
