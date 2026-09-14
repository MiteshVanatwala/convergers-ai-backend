import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { loadEnv } from "../../config/env";
import { hashToken } from "../../shared/utils/session-token";
import { logCaught } from "../../shared/utils/log";
import { ensureWallet, grantSignupCredits } from "../ledger/ledger.service";
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
}): Promise<AccountRow> {
  try {
    return await withPoolTransaction(async (client: PoolClient): Promise<AccountRow> => {
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
        return updated.rows[0];
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
        return updated.rows[0];
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
      return created;
    });
  } catch (error: unknown) {
    logCaught("auth.service.upsertGoogleAccount", error);
    throw error;
  }
}

export async function createSession(input: {
  accountId: string;
  token: string;
  ip?: string | null;
  userAgent?: string | null;
  audience?: string;
}): Promise<string> {
  try {
    const pool = getPool();
    const ttlDays: number = loadEnv().sessionTtlDays;
    const createParams: [string, string, string, string, string | null, string | null] = [
      input.accountId,
      hashToken(input.token),
      input.audience ?? "web",
      String(ttlDays),
      input.ip ?? null,
      input.userAgent ?? null,
    ];
    const result: QueryResult<{ id: string }> = await pool.query<{ id: string }>(
      `INSERT INTO sessions (account_id, token_hash, audience, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5::inet, $6)
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
         s.id AS session_id
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
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
): Promise<SessionAccount | null> {
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
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, session_id: "" };
  } catch (error: unknown) {
    logCaught("auth.service.updateProfileName", error);
    throw error;
  }
}
