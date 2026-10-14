import type { MemberAnswer, RouteResponse } from "@convergers-ai/shared-types";
import type { TaskType } from "../classifier";
import type { BrainRequest, ProviderAdapter } from "../adapters/types";
import { RequestStoppedError, UserFacingError, isCapacityError } from "../router/errors";
import { explicitAdapter, modelLabel, multiModelCandidates, routeWithAdapter } from "../router";
import { Tally, memberName, quote, withoutArtifacts, type ChatResult, type MultiCallbacks } from "./types";

/**
 * Model Council: several models from different families answer the same
 * message independently, then a chair merges them into one answer that says
 * where they agree and where they differ. Debate adds a round in between
 * where each member reads the others' answers and revises its own
 * (multi-agent debate improves factuality and reasoning — Du et al., 2023).
 * Compare runs the members and lets the user pick the best answer instead.
 *
 * Every call is an ordinary routed call (routeWithAdapter): credit-checked,
 * billed and logged on its own, so a council costs the sum of its calls.
 */

const COUNCIL_SIZE = 3;
/** Members run at once, so a provider's per-minute limit can trip; wait this long and retry once. */
const RATE_LIMIT_RETRY_MS = 1500;
const COMPARE_SIZE = 2;
const MAX_COMPARE = 3;

type Member = { adapter: ProviderAdapter; index: number; response: RouteResponse };

/** "None of the models could answer" plus why, per model — so the user (and we) can see what to fix. */
function noneAnswered(failures: MemberAnswer[]): UserFacingError {
  const reasons = failures
    .slice(0, 4)
    .map((f) => `${modelLabel(f.provider)}: ${f.content.replace(/\s+/g, " ").slice(0, 160)}`)
    .join(" · ");
  return new UserFacingError(
    `None of the models could answer right now. Please try again shortly.${reasons ? ` (${reasons})` : ""}`
  );
}

/**
 * Fills `size` member slots in parallel. A slot whose model fails takes the
 * next candidate from the shared queue, so one broken provider doesn't
 * shrink the council. Returns members in slot order (A, B, C).
 */
async function runMembers(
  size: number,
  queue: ProviderAdapter[],
  request: BrainRequest,
  taskType: TaskType,
  accountId: string,
  cb: MultiCallbacks,
  tally: Tally,
  failures: MemberAnswer[]
): Promise<Member[]> {
  const memberRequest = withoutArtifacts(request);
  const call = async (adapter: ProviderAdapter): Promise<RouteResponse> => {
    try {
      return await routeWithAdapter(adapter, memberRequest, taskType, accountId, cb.ctx, { signal: cb.signal });
    } catch (err) {
      if (!isCapacityError(err) || cb.signal?.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
      return routeWithAdapter(adapter, memberRequest, taskType, accountId, cb.ctx, { signal: cb.signal });
    }
  };
  const slot = async (index: number): Promise<Member | null> => {
    while (queue.length > 0) {
      const adapter = queue.shift()!;
      cb.onStage?.({ stage: "member", index, provider: adapter.id, round: "answer", status: "start" });
      try {
        const response = await call(adapter);
        tally.addResponse(response);
        cb.onStage?.({ stage: "member", index, provider: adapter.id, round: "answer", status: "done" });
        return { adapter, index, response };
      } catch (err) {
        if (err instanceof RequestStoppedError || cb.signal?.aborted) throw new RequestStoppedError();
        cb.onStage?.({ stage: "member", index, provider: adapter.id, round: "answer", status: "failed" });
        failures.push({
          provider: adapter.id,
          content: err instanceof Error ? err.message : "Failed",
          credits: 0,
          failed: true,
        });
      }
    }
    return null;
  };
  const filled = await Promise.all(Array.from({ length: size }, (_, i) => slot(i)));
  return filled.filter((m): m is Member => m !== null);
}

function debatePrompt(question: string, own: string, others: { name: string; content: string }[]): string {
  return `You already answered the user's latest message. Other AI models answered it too. Review all the answers critically: check facts, reasoning and any calculations; note what the others got right that you missed, and anything that's wrong — including in your own answer.

Then write your revised final answer to the user's message.

Format exactly:
Critique: <a short paragraph>
Revised answer:
<the complete revised answer>

The user's latest message:
${quote(question)}

Your answer:
${quote(own)}

${others.map((o) => `${o.name}'s answer:\n${quote(o.content)}`).join("\n\n")}`;
}

/** The text after "Revised answer:", or the whole reply if the model ignored the format. */
function revisedPart(reply: string): string {
  const match = reply.match(/revised answer:\s*([\s\S]+)$/i);
  return (match?.[1] ?? reply).trim();
}

function chairPrompt(question: string, answers: { name: string; content: string }[], debated: boolean): string {
  return `You are chairing a council of AI models. Each answered the user's latest message independently${
    debated ? ", then read the others' answers and revised its own" : ""
  }. Their final answers are below, labelled anonymously.

Write the reply the user will see:
1. The best final answer to the user's message — merge what the models got right, correct what they got wrong, and keep it as concise as the question deserves. Don't mention the council or the models in this part.
2. A short section "## Where the models agree" — bullet points.
3. A short section "## Where they differ" — each real disagreement, which view is right and why (or that it's genuinely uncertain). Write "No real disagreements." if there are none.
4. A final line exactly in the form: Consensus: high, Consensus: medium, or Consensus: low

The user's latest message:
${quote(question)}

${answers.map((a) => `${a.name}:\n${quote(a.content)}`).join("\n\n")}`;
}

function parseAgreement(content: string): "high" | "medium" | "low" | undefined {
  const match = content.match(/consensus:\s*\**\s*(high|medium|low)\b/i);
  return match ? (match[1]!.toLowerCase() as "high" | "medium" | "low") : undefined;
}

export async function runCouncil(
  request: BrainRequest,
  taskType: TaskType,
  accountId: string,
  mode: "council" | "debate",
  cb: MultiCallbacks,
  tally: Tally
): Promise<ChatResult> {
  const candidates = await multiModelCandidates(request, taskType, accountId, cb.ctx);
  if (candidates.length < 2) {
    throw new UserFacingError(
      `A council needs at least two models that can answer this kind of request (${taskType}); only ${candidates.length} is available.`
    );
  }
  const queue = [...candidates];
  const failures: MemberAnswer[] = [];
  const members = await runMembers(
    Math.min(COUNCIL_SIZE, candidates.length),
    queue,
    request,
    taskType,
    accountId,
    cb,
    tally,
    failures
  );
  if (members.length === 0) throw noneAnswered(failures);

  const answers: MemberAnswer[] = members.map((m) => ({
    provider: m.adapter.id,
    content: m.response.content,
    credits: m.response.credits_charged,
    inputTokens: m.response.usage.input_tokens,
    outputTokens: m.response.usage.output_tokens,
  }));

  // One model alone isn't a council — return its answer and say so.
  if (members.length === 1) {
    const only = members[0]!;
    const note = "_Only one council member could answer right now, so this is its answer alone._\n\n";
    cb.onDelta(note + only.response.content);
    return tally.result(only.adapter.id, note + only.response.content, {
      mode,
      members: [...answers, ...failures],
    });
  }

  if (mode === "debate") {
    const memberRequest = withoutArtifacts(request);
    await Promise.all(
      members.map(async (m, i) => {
        cb.onStage?.({ stage: "member", index: m.index, provider: m.adapter.id, round: "debate", status: "start" });
        const others = members
          .filter((o) => o !== m)
          .map((o) => ({ name: memberName(o.index), content: o.response.content }));
        try {
          const reply = await routeWithAdapter(
            m.adapter,
            { ...memberRequest, input: debatePrompt(request.input, m.response.content, others) },
            taskType,
            accountId,
            cb.ctx,
            { signal: cb.signal }
          );
          tally.addResponse(reply);
          const prev = answers[i]!;
          answers[i] = {
            ...prev,
            revised: revisedPart(reply.content),
            credits: prev.credits + reply.credits_charged,
            inputTokens: (prev.inputTokens ?? 0) + reply.usage.input_tokens,
            outputTokens: (prev.outputTokens ?? 0) + reply.usage.output_tokens,
          };
          cb.onStage?.({ stage: "member", index: m.index, provider: m.adapter.id, round: "debate", status: "done" });
        } catch (err) {
          if (err instanceof RequestStoppedError || cb.signal?.aborted) throw new RequestStoppedError();
          // Its first answer still stands.
          cb.onStage?.({ stage: "member", index: m.index, provider: m.adapter.id, round: "debate", status: "failed" });
        }
      })
    );
  }

  // The chair: the highest-ranked model that answered (the Auto chain's order).
  const chairs = members
    .map((m) => m.adapter)
    .sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
  const finals = members.map((m, i) => ({ name: memberName(m.index), content: answers[i]!.revised ?? answers[i]!.content }));
  const chairRequest: BrainRequest = { ...request, input: chairPrompt(request.input, finals, mode === "debate") };

  let lastError: unknown;
  for (const chair of chairs) {
    cb.onStage?.({ stage: "judge", provider: chair.id });
    try {
      const verdict = await routeWithAdapter(chair, chairRequest, taskType, accountId, cb.ctx, {
        onDelta: cb.onDelta,
        signal: cb.signal,
      });
      tally.addResponse(verdict);
      return tally.result(
        chair.id,
        verdict.content,
        { mode, members: [...answers, ...failures], agreement: parseAgreement(verdict.content) },
        {
          ...(verdict.truncated ? { truncated: true } : {}),
          ...(verdict.stopped ? { stopped: true } : {}),
        }
      );
    } catch (err) {
      if (err instanceof RequestStoppedError || cb.signal?.aborted) throw new RequestStoppedError();
      lastError = err;
    }
  }
  throw lastError instanceof UserFacingError
    ? lastError
    : new UserFacingError("The council's answers are in, but no model could write the final verdict. Please try again.");
}

/**
 * Compare: 2–3 models answer side by side and the user picks the best
 * (conversations.service.chooseCandidate records the vote). The first
 * answer stands in as the turn's answer until they pick.
 */
export async function runCompare(
  request: BrainRequest,
  taskType: TaskType,
  accountId: string,
  providerIds: string[],
  cb: MultiCallbacks,
  tally: Tally
): Promise<ChatResult> {
  const picked: ProviderAdapter[] = [];
  for (const id of [...new Set(providerIds)].slice(0, MAX_COMPARE)) {
    picked.push(await explicitAdapter(request, id, taskType, accountId, cb.ctx));
  }
  const auto = (await multiModelCandidates(request, taskType, accountId, cb.ctx)).filter(
    (a) => !picked.some((p) => p.id === a.id)
  );
  const size = Math.max(COMPARE_SIZE, picked.length);
  if (picked.length + auto.length < 2) {
    throw new UserFacingError(`Compare needs at least two models that can answer this kind of request (${taskType}).`);
  }
  // The user's picks first (no substitutes for them), then automatic choices.
  const failures: MemberAnswer[] = [];
  const pickedMembers = await runMembers(picked.length, [...picked], request, taskType, accountId, cb, tally, failures);
  const autoMembers = await runMembers(
    Math.max(0, size - pickedMembers.length),
    auto,
    request,
    taskType,
    accountId,
    { ...cb, onStage: (e) => cb.onStage?.(e.stage === "member" ? { ...e, index: e.index + pickedMembers.length } : e) },
    tally,
    failures
  );
  const members = [...pickedMembers, ...autoMembers];
  if (members.length === 0) throw noneAnswered(failures);
  const candidates: MemberAnswer[] = members.map((m) => ({
    provider: m.adapter.id,
    content: m.response.content,
    credits: m.response.credits_charged,
    inputTokens: m.response.usage.input_tokens,
    outputTokens: m.response.usage.output_tokens,
  }));
  const first = members[0]!;
  return tally.result(first.adapter.id, first.response.content, {
    mode: "compare",
    candidates: [...candidates, ...failures],
    chosen: null,
  });
}
