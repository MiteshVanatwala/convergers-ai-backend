import type { RouteRequest } from "@convergers-ai/shared-types";
import { CREDITS_PER_USD, creditsForCost, getBalance } from "../../ledger/ledger.service";
import { hasOwnKey } from "../adapters/accountKeyResolver";
import { PRICING } from "../adapters/pricing";
import type { BrainRequest, ProviderAdapter } from "../adapters/types";
import { INSUFFICIENT_CREDITS_CODE, UserFacingError } from "./errors";

/** Flat platform fee for a request served on the account's own provider key. */
export const BYOK_FEE_CREDITS = 25;

/** Below this, an answer would be too short to be useful — try a cheaper model instead. */
const MIN_AFFORDABLE_OUTPUT_TOKENS = 500;

// Deliberately conservative (real English averages ~4 chars/token) so the
// estimate errs toward reserving too much, not too little.
const CHARS_PER_TOKEN = 3.5;
// Adapter system prompt + message framing, not visible in the request itself.
const PROMPT_OVERHEAD_TOKENS = 200;

export type AttemptPlan = {
  /** Runs on the account's own key — charged BYOK_FEE_CREDITS, not model cost. */
  byok: boolean;
  /** Request to send, with `maxOutputTokens` set to what the balance can pay for. */
  request: RouteRequest;
  /** True when the output cap was lowered because of the balance (not the model's own cap). */
  cappedByCredits: boolean;
};

export function estimateInputTokens(request: RouteRequest): number {
  const brain = request as BrainRequest;
  const chars =
    request.input.length +
    (request.history ?? []).reduce((sum, turn) => sum + turn.content.length, 0) +
    (brain.systemNote?.length ?? 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
}

function insufficient(message: string): UserFacingError {
  return new UserFacingError(message, { code: INSUFFICIENT_CREDITS_CODE });
}

/**
 * Prices one attempt before it's made. Throws an insufficient-credits
 * UserFacingError when the account can't afford it — walkChain treats that
 * like any other failed option and moves on to the next (cheaper) one.
 */
export async function planAttempt(
  adapter: ProviderAdapter,
  request: RouteRequest,
  accountId: string,
  label: string
): Promise<AttemptPlan> {
  const [byok, balance] = await Promise.all([
    hasOwnKey(adapter.keyProviderId, accountId),
    getBalance(accountId),
  ]);
  return priceAttempt(adapter, request, { byok, balance, label });
}

/** Pure pricing decision for one attempt, given whose key it runs on and the balance. */
export function priceAttempt(
  adapter: ProviderAdapter,
  request: RouteRequest,
  { byok, balance, label }: { byok: boolean; balance: number; label: string }
): AttemptPlan {
  if (byok) {
    if (balance < BYOK_FEE_CREDITS) {
      throw insufficient(
        `Requests that use your own ${label} key cost ${BYOK_FEE_CREDITS} credits each, and you have ` +
          `${balance}. Buy more credits to keep chatting.`
      );
    }
    return { byok: true, request, cappedByCredits: false };
  }

  const { cost } = adapter;
  if (cost.kind === "flat") {
    const needed = creditsForCost(cost.usd);
    if (balance < needed) {
      throw insufficient(
        `${label} needs ${needed} credits per request, and you have ${balance}. Buy more credits to continue.`
      );
    }
    return { byok: false, request, cappedByCredits: false };
  }

  const rate = PRICING[cost.model];
  if (!rate) {
    // Can't price it, so can't prove it's affordable — fail this option closed.
    throw new Error(`No pricing configured for model: ${cost.model}`);
  }

  const inputUsd = (estimateInputTokens(request) / 1_000_000) * rate.inputPerMTok;
  const spendableUsd = balance / CREDITS_PER_USD - inputUsd;
  const affordableOutput = Math.floor(spendableUsd / (rate.outputPerMTok / 1_000_000));

  if (affordableOutput < MIN_AFFORDABLE_OUTPUT_TOKENS) {
    throw insufficient(
      `You don't have enough credits for ${label} (balance: ${balance}). ` +
        `Buy more credits, or pick a cheaper model.`
    );
  }

  if (affordableOutput >= cost.maxOutputTokens) {
    return { byok: false, request, cappedByCredits: false };
  }
  const capped: BrainRequest = { ...request, maxOutputTokens: affordableOutput };
  return { byok: false, request: capped, cappedByCredits: true };
}
