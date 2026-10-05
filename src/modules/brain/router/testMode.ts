import type { QueryResult } from "pg";
import { getPool } from "../../../infrastructure/db/pool";
import { logCaught } from "../../../shared/utils/log";
import { PRICING } from "../adapters/pricing";
import type { ProviderAdapter } from "../adapters/types";

/**
 * Test mode (accounts.test_mode, set on Admin → Users): Auto routing ranks
 * each task's models cheapest-first for the account, to keep testing costs
 * down. Explicit model picks are untouched.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Short cache: the flag is read on every request but changes rarely. */
const TTL_MS = 15_000;
const cache = new Map<string, { value: boolean; at: number }>();

export async function isTestModeAccount(accountId: string): Promise<boolean> {
  if (!UUID_RE.test(accountId)) return false;
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const result: QueryResult<{ test_mode: boolean }> = await getPool().query(
      `SELECT test_mode FROM accounts WHERE id = $1`,
      [accountId]
    );
    const value = result.rows[0]?.test_mode === true;
    cache.set(accountId, { value, at: Date.now() });
    return value;
  } catch (error: unknown) {
    // Before test_mode_v1.sql is applied the column doesn't exist — treat as off.
    logCaught("brain.router.testMode.isTestModeAccount", error);
    return false;
  }
}

/** Called after an admin changes the flag, so it applies on the next request. */
export function forgetTestMode(accountId: string): void {
  cache.delete(accountId);
}

/** A typical chat turn, for comparing per-token models with flat-priced ones. */
const TYPICAL_INPUT_TOKENS = 2_000;
const TYPICAL_OUTPUT_TOKENS = 800;

export function typicalRequestUsd(adapter: ProviderAdapter): number {
  if (adapter.typicalUsd !== undefined) return adapter.typicalUsd;
  if (adapter.cost.kind === "flat") return adapter.cost.usd;
  const rate = PRICING[adapter.cost.model];
  // Unpriced models sort last rather than being treated as free.
  if (!rate) return Number.POSITIVE_INFINITY;
  return (TYPICAL_INPUT_TOKENS * rate.inputPerMTok + TYPICAL_OUTPUT_TOKENS * rate.outputPerMTok) / 1_000_000;
}

/**
 * In test mode, Auto leaves out models above this typical cost per request
 * (e.g. Claude images at ~$0.30) — unless nothing cheaper can do the job.
 */
export const TEST_MODE_MAX_USD = 0.1;

/** Cheapest first; ties keep the admin's order. */
export function cheapestFirst(chain: ProviderAdapter[]): ProviderAdapter[] {
  return chain
    .map((adapter, index) => ({ adapter, index, usd: typicalRequestUsd(adapter) }))
    .sort((a, b) => a.usd - b.usd || a.index - b.index)
    .map((entry) => entry.adapter);
}
