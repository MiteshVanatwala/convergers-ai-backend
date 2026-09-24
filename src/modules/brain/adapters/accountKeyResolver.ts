import type { QueryResult } from "pg";
import { getPool } from "../../../infrastructure/db/pool";
import { decryptProviderKey } from "../../../shared/utils/provider-key-crypto";
import { getOrEnsureActivePlan } from "../../plans/plans.service";
import { getKey } from "./keyStore";

/**
 * Resolves the API key a call should actually use, per account:
 *   1. The account's own key for this credential, if they've added one —
 *      always wins, no tier check needed, it's their own resource.
 *   2. Otherwise, the master (admin-set) key — but only if the account's
 *      current plan is allowed to use this specific model
 *      (provider_tier_access). Not allowed -> throws, which `walkChain`
 *      (router/index.ts) treats the same as any other adapter failure: try
 *      the next option in the chain, or surface it directly for an explicit
 *      pick.
 *
 * `accountId: null` is for internal, non-user-attributed calls (the
 * sensitive-data detection chain) — these always use the master key,
 * skipping both the own-key lookup and the tier check.
 */
export async function resolveKeyForAccount(
  modelId: string,
  providerKeyId: string,
  providerLabel: string,
  accountId: string | null
): Promise<string> {
  if (accountId) {
    const pool = getPool();
    const own: QueryResult<{ encrypted_key: Buffer }> = await pool.query(
      `SELECT encrypted_key FROM provider_api_keys
       WHERE provider_id = $1 AND account_id = $2 AND is_active = true
       ORDER BY rotated_at DESC LIMIT 1`,
      [providerKeyId, accountId]
    );
    const ownRow = own.rows[0];
    if (ownRow) return decryptProviderKey(ownRow.encrypted_key);

    const plan = await getOrEnsureActivePlan(accountId);
    const tier: QueryResult<{ provider_id: string }> = await pool.query(
      `SELECT provider_id FROM provider_tier_access WHERE provider_id = $1 AND plan_key = $2`,
      [modelId, plan.key]
    );
    if (tier.rows.length === 0) {
      throw new Error(
        `${providerLabel} requires a higher plan, or add your own ${providerLabel} key in Settings.`
      );
    }
  }

  const masterKey = getKey(providerKeyId);
  if (!masterKey) {
    throw new Error(
      `${providerLabel} isn't configured — add a key on the admin panel's API Keys page, or set the env var in backend/.env`
    );
  }
  return masterKey;
}
