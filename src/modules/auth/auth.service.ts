import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { loadEnv } from "../../config/env";
import { hashToken } from "../../shared/utils/session-token";
import { logCaught } from "../../shared/utils/log";
import { ensureWallet, grantSignupCredits } from "../ledger/ledger.service";
import { ensureFreePlanMembership } from "../plans/plans.service";
import type { AccountRow, SessionAccount } from "./types";

type AccountWithGoogleId = AccountRow & { google_id: string | null };

export async function insertOAuthState(state: string, audience: string = "web"): Promise<void> {
  try {
    const pool = getPool();
    const insertParams: [string, string] = [state, audience];
    await pool.query(
      `INSERT INTO oauth_states (state, audience, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')`,
      insertParams
    );
  } catch (error: unknown) {
    logCaught("auth.service.insertOAuthState", error);
    throw error;
  }
}

/** Consume state if valid; returns true when accepted. */
export async function consumeOAuthState(state: string, audience: string = "web"): Promise<boolean> {
  try {
    const pool = getPool();
    const consumeParams: [string, string] = [state, audience];
    const result: QueryResult<{ state: string }> = await pool.query(
      `UPDATE oauth_states
       SET consumed_at = now()
       WHERE state = $1
         AND audience = $2
         AND consumed_at IS NULL
         AND expires_at > now()
       RETURNING state`,
      consumeParams
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("auth.service.consumeOAuthState", error);
    throw error;
  }
}

export async function upsertGoogleAccount(input: {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  pictureUrl: string | null;
}): Promise<AccountRow & { isNew: boolean }> {
  try {
    return await withPoolTransaction(async (client: PoolClient): Promise<AccountRow & { isNew: boolean }> => {
      const byGoogleParams: [string] = [input.googleId];
      const byGoogle: QueryResult<AccountRow> = await client.query<AccountRow>(
        `SELECT id, email, name, avatar_url, auth_provider, status, created_at
         FROM accounts WHERE google_id = $1`,
        byGoogleParams
      );
      if (byGoogle.rows[0]) {
        const updateByGoogleParams: [string, string | null, string | null, string, boolean] = [
          byGoogle.rows[0].id,
          input.name,
          input.pictureUrl,
          input.email,
          input.emailVerified,
        ];
        const updated: QueryResult<AccountRow> = await client.query<AccountRow>(
          `UPDATE accounts
           SET name = COALESCE($2, name),
               avatar_url = COALESCE($3, avatar_url),
               email = $4,
               email_verified_at = CASE WHEN $5 THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END,
               updated_at = now()
           WHERE id = $1
           RETURNING id, email, name, avatar_url, auth_provider, status, created_at`,
          updateByGoogleParams
        );
        await ensureWallet(updated.rows[0].id, client);
        await ensureFreePlanMembership(updated.rows[0].id, client, "migration");
        return { ...updated.rows[0], isNew: false };
      }

      const byEmailParams: [string] = [input.email];
      const byEmail: QueryResult<AccountWithGoogleId> = await client.query<AccountWithGoogleId>(
        `SELECT id, email, name, avatar_url, auth_provider, status, created_at, google_id
         FROM accounts WHERE email = $1`,
        byEmailParams
      );
      if (byEmail.rows[0]) {
        const existingRow: AccountWithGoogleId = byEmail.rows[0];
        if (existingRow.google_id && existingRow.google_id !== input.googleId) {
          throw new Error("email_linked_to_other_google");
        }
        const linkParams: [string, string, string | null, string | null, boolean] = [
          existingRow.id,
          input.googleId,
          input.name,
          input.pictureUrl,
          input.emailVerified,
        ];
        const updated: QueryResult<AccountRow> = await client.query<AccountRow>(
          `UPDATE accounts
           SET google_id = $2,
               auth_provider = 'google',
               name = COALESCE($3, name),
               avatar_url = COALESCE($4, avatar_url),
               email_verified_at = CASE WHEN $5 THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END,
               updated_at = now()
           WHERE id = $1
           RETURNING id, email, name, avatar_url, auth_provider, status, created_at`,
          linkParams
        );
        await ensureWallet(updated.rows[0].id, client);
        await ensureFreePlanMembership(updated.rows[0].id, client, "migration");
        return { ...updated.rows[0], isNew: false };
      }

      const insertParams: [string, boolean, string, string | null, string | null] = [
        input.email,
        input.emailVerified,
        input.googleId,
        input.name,
        input.pictureUrl,
      ];
      const inserted: QueryResult<AccountRow> = await client.query<AccountRow>(
        `INSERT INTO accounts (
           email, email_verified_at, auth_provider, google_id, name, avatar_url, status
         ) VALUES (
           $1, CASE WHEN $2 THEN now() ELSE NULL END, 'google', $3, $4, $5, 'active'
         )
         RETURNING id, email, name, avatar_url, auth_provider, status, created_at`,
        insertParams
      );
      const created: AccountRow = inserted.rows[0];
      await grantSignupCredits(created.id, client);
      await ensureFreePlanMembership(created.id, client, "signup");
      return { ...created, isNew: true };
    });
  } catch (error: unknown) {
    logCaught("auth.service.upsertGoogleAccount", error);
    throw error;
  }
}

/**
 * Email-code sign-in: returns the account for this (now verified) email,
 * creating it on first use the same way Google sign-up does (wallet, signup
 * credits, Free plan). An existing Google account with this email is reused,
 * so both sign-in methods land in one account.
 */
export async function upsertEmailAccount(email: string): Promise<AccountRow & { isNew: boolean }> {
  try {
    return await withPoolTransaction(async (client: PoolClient): Promise<AccountRow & { isNew: boolean }> => {
      const existing: QueryResult<AccountRow> = await client.query<AccountRow>(
        `UPDATE accounts
         SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
         WHERE email = $1
         RETURNING id, email, name, avatar_url, auth_provider, status, created_at`,
        [email]
      );
      if (existing.rows[0]) {
        await ensureWallet(existing.rows[0].id, client);
        await ensureFreePlanMembership(existing.rows[0].id, client, "migration");
        return { ...existing.rows[0], isNew: false };
      }

      const inserted: QueryResult<AccountRow> = await client.query<AccountRow>(
        `INSERT INTO accounts (email, email_verified_at, auth_provider, status)
         VALUES ($1, now(), 'email', 'active')
         RETURNING id, email, name, avatar_url, auth_provider, status, created_at`,
        [email]
      );
      const created: AccountRow = inserted.rows[0];
      await grantSignupCredits(created.id, client);
      await ensureFreePlanMembership(created.id, client, "signup");
      return { ...created, isNew: true };
    });
  } catch (error: unknown) {
    logCaught("auth.service.upsertEmailAccount", error);
    throw error;
  }
}

export async function createSession(input: {
  accountId: string;
  token: string;
  ip?: string | null;
  userAgent?: string | null;
  audience?: string;
  /** When set, expires_at uses minutes instead of the default day-based TTL — impersonation sessions are short-lived by design. */
  ttlMinutes?: number;
  impersonatedBy?: string | null;
  impersonationReason?: string | null;
  client?: PoolClient;
}): Promise<string> {
  try {
    const db = input.client ?? getPool();
    const ttlDays: number = loadEnv().sessionTtlDays;
    const useMinutes = input.ttlMinutes != null;
    const ttlValue = useMinutes ? input.ttlMinutes! : ttlDays;
    const expiresExpr = useMinutes
      ? `now() + ($4::int * interval '1 minute')`
      : `now() + ($4::int * interval '1 day')`;
    const createParams: [
      string,
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
    ] = [
      input.accountId,
      hashToken(input.token),
      input.audience ?? "web",
      ttlValue,
      input.ip ?? null,
      input.userAgent ?? null,
      input.impersonatedBy ?? null,
      input.impersonationReason ?? null,
    ];
    const result: QueryResult<{ id: string }> = await db.query<{ id: string }>(
      `INSERT INTO sessions (account_id, token_hash, audience, expires_at, ip_address, user_agent, impersonated_by, impersonation_reason)
       VALUES ($1, $2, $3, ${expiresExpr}, $5::inet, $6, $7, $8)
       RETURNING id`,
      createParams
    );
    return result.rows[0].id;
  } catch (error: unknown) {
    logCaught("auth.service.createSession", error);
    throw error;
  }
}

export async function recordLogin(
  accountId: string,
  ip?: string | null,
  userAgent?: string | null
): Promise<void> {
  try {
    const pool = getPool();
    const loginParams: [string, string | null, string | null] = [accountId, ip ?? null, userAgent ?? null];
    await pool.query(
      `INSERT INTO login_events (account_id, ip_address, user_agent, is_new_device)
       VALUES ($1, $2::inet, $3, false)`,
      loginParams
    );
    const accountParams: [string] = [accountId];
    await pool.query(
      `UPDATE accounts SET last_login_at = now(), updated_at = now() WHERE id = $1`,
      accountParams
    );
  } catch (error: unknown) {
    logCaught("auth.service.recordLogin", error);
    throw error;
  }
}

export async function resolveSession(token: string): Promise<SessionAccount | null> {
  try {
    const pool = getPool();
    const resolveParams: [string] = [hashToken(token)];
    const result: QueryResult<SessionAccount> = await pool.query<SessionAccount>(
      `SELECT
         a.id, a.email, a.name, a.avatar_url, a.auth_provider, a.status, a.created_at,
         s.id AS session_id,
         s.impersonated_by,
         COALESCE(au.username, au.email)::text AS impersonator_label
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN admin_users au ON au.id = s.impersonated_by
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND a.status = 'active'`,
      resolveParams
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("auth.service.resolveSession", error);
    throw error;
  }
}

export async function revokeSession(token: string): Promise<void> {
  try {
    const pool = getPool();
    const revokeParams: [string] = [hashToken(token)];
    await pool.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      revokeParams
    );
  } catch (error: unknown) {
    logCaught("auth.service.revokeSession", error);
    throw error;
  }
}

export async function updateProfileName(
  accountId: string,
  name: string | null
): Promise<AccountRow | null> {
  try {
    const pool = getPool();
    const result: QueryResult<AccountRow> = await pool.query<AccountRow>(
      `UPDATE accounts
       SET name = $2,
           updated_at = now()
       WHERE id = $1
         AND status = 'active'
       RETURNING id, email, name, avatar_url, auth_provider, status, created_at`,
      [accountId, name]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("auth.service.updateProfileName", error);
    throw error;
  }
}

export type PersonalizationSettings = {
  defaultModelId: string | null;
  filterSensitiveData: boolean;
};

export async function getPersonalizationSettings(accountId: string): Promise<PersonalizationSettings> {
  try {
    const pool = getPool();
    const result: QueryResult<{
      default_provider_override: string | null;
      filter_sensitive_data: boolean;
    }> = await pool.query(
      `SELECT default_provider_override, filter_sensitive_data
       FROM personalization_settings WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    return {
      defaultModelId: row?.default_provider_override ?? null,
      filterSensitiveData: row?.filter_sensitive_data ?? false,
    };
  } catch (error: unknown) {
    logCaught("auth.service.getPersonalizationSettings", error);
    throw error;
  }
}

/** Read-modify-write: only the provided fields change, everything else keeps its current value. */
export async function updatePersonalizationSettings(
  accountId: string,
  input: { defaultModelId?: string | null; filterSensitiveData?: boolean }
): Promise<"ok" | "invalid_model"> {
  try {
    const pool = getPool();
    if (input.defaultModelId !== undefined && input.defaultModelId !== null) {
      const check: QueryResult<{ exists: boolean }> = await pool.query(
        `SELECT true AS exists FROM provider_registry
         WHERE id = $1 AND visible_to_users = true AND status = 'active'`,
        [input.defaultModelId]
      );
      if (!check.rows[0]) return "invalid_model";
    }

    const current = await getPersonalizationSettings(accountId);
    const nextDefaultModelId =
      input.defaultModelId !== undefined ? input.defaultModelId : current.defaultModelId;
    const nextFilterSensitiveData =
      input.filterSensitiveData !== undefined ? input.filterSensitiveData : current.filterSensitiveData;

    await pool.query(
      `INSERT INTO personalization_settings (account_id, default_provider_override, filter_sensitive_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         default_provider_override = EXCLUDED.default_provider_override,
         filter_sensitive_data = EXCLUDED.filter_sensitive_data`,
      [accountId, nextDefaultModelId, nextFilterSensitiveData]
    );
    return "ok";
  } catch (error: unknown) {
    logCaught("auth.service.updatePersonalizationSettings", error);
    throw error;
  }
}
