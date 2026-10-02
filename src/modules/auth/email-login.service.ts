import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";

export const LOGIN_CODE_TTL_MINUTES = 10;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

/** How many codes were sent to this email recently — for per-email send limits. */
export async function getRecentCodeSends(
  email: string
): Promise<{ lastSentAt: Date | null; sentLastHour: number }> {
  try {
    const result: QueryResult<{ last_sent_at: Date | null; sent_last_hour: string }> = await getPool().query(
      `SELECT MAX(created_at) AS last_sent_at,
              COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::text AS sent_last_hour
       FROM email_login_codes
       WHERE email = $1 AND created_at > now() - interval '1 hour'`,
      [email]
    );
    const row = result.rows[0];
    return { lastSentAt: row?.last_sent_at ?? null, sentLastHour: Number(row?.sent_last_hour ?? 0) };
  } catch (error: unknown) {
    logCaught("auth.email-login.service.getRecentCodeSends", error);
    throw error;
  }
}

/** Stores a new code and retires any older unused code for the same email. */
export async function createLoginCode(input: {
  email: string;
  salt: string;
  hash: string;
  ip: string | null;
}): Promise<void> {
  try {
    await withPoolTransaction(async (client: PoolClient) => {
      await client.query(
        `UPDATE email_login_codes SET consumed_at = now()
         WHERE email = $1 AND consumed_at IS NULL`,
        [input.email]
      );
      await client.query(
        `INSERT INTO email_login_codes (email, code_salt, code_hash, expires_at, ip_address)
         VALUES ($1, $2, $3, now() + ($4::int * interval '1 minute'), $5::inet)`,
        [input.email, input.salt, input.hash, LOGIN_CODE_TTL_MINUTES, input.ip]
      );
    });
  } catch (error: unknown) {
    logCaught("auth.email-login.service.createLoginCode", error);
    throw error;
  }
}

export type CodeCheckResult = "ok" | "invalid" | "expired" | "too_many_attempts";

/**
 * Checks `matches` against the email's open code, inside a row lock so two
 * parallel guesses can't both count as one attempt. A match consumes the
 * code; a miss uses up an attempt.
 */
export async function consumeLoginCode(
  email: string,
  matches: (salt: string, hash: string) => boolean
): Promise<CodeCheckResult> {
  try {
    return await withPoolTransaction(async (client: PoolClient): Promise<CodeCheckResult> => {
      const open: QueryResult<{
        id: string;
        code_salt: string;
        code_hash: string;
        attempts: number;
        expired: boolean;
      }> = await client.query(
        `SELECT id::text AS id, code_salt, code_hash, attempts, expires_at <= now() AS expired
         FROM email_login_codes
         WHERE email = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [email]
      );
      const code = open.rows[0];
      if (!code || code.expired) return "expired";
      if (code.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return "too_many_attempts";

      if (!matches(code.code_salt, code.code_hash)) {
        await client.query(`UPDATE email_login_codes SET attempts = attempts + 1 WHERE id = $1`, [code.id]);
        return code.attempts + 1 >= LOGIN_CODE_MAX_ATTEMPTS ? "too_many_attempts" : "invalid";
      }
      await client.query(`UPDATE email_login_codes SET consumed_at = now() WHERE id = $1`, [code.id]);
      return "ok";
    });
  } catch (error: unknown) {
    logCaught("auth.email-login.service.consumeLoginCode", error);
    throw error;
  }
}
