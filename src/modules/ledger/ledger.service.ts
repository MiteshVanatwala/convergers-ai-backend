import type { PoolClient, QueryResult } from "pg";
import { loadEnv } from "../../config/env";
import { LedgerReason, LedgerReferenceType } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";

const CREDITS_PER_USD = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** In-memory balances for admin POC client ids that are not real account UUIDs. */
const adminPocBalances = new Map<string, number>();

type Queryable = PoolClient | ReturnType<typeof getPool>;

function isAccountUuid(accountId: string): boolean {
  return UUID_RE.test(accountId);
}

function asNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

async function runQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Queryable,
  text: string,
  params: unknown[]
): Promise<QueryResult<T>> {
  return db.query<T>(text, params);
}

export function creditsForCost(nativeCostUsd: number): number {
  return Math.max(1, Math.ceil(nativeCostUsd * CREDITS_PER_USD));
}

/** Ensure a wallet row exists (balance 0). Idempotent. */
export async function ensureWallet(accountId: string, client?: PoolClient): Promise<void> {
  try {
    const db: Queryable = client ?? getPool();
    await runQuery(
      db,
      `INSERT INTO credit_wallets (account_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId]
    );
  } catch (error: unknown) {
    logCaught("ledger.service.ensureWallet", error);
    throw error;
  }
}

/**
 * Grant signup credits once per account. Call only inside the new-account
 * create transaction (pass the same PoolClient).
 * Idempotency: skip if a signup_grant ledger row already exists for this account.
 */
export async function grantSignupCredits(
  accountId: string,
  client: PoolClient,
  amount?: number
): Promise<{ granted: number; balance: number }> {
  try {
    const grantAmount: number = amount ?? loadEnv().signupGrantCredits;
    await ensureWallet(accountId, client);

    const existing: QueryResult<{ id: string }> = await runQuery(
      client,
      `SELECT id::text AS id
       FROM credit_ledger
       WHERE account_id = $1 AND reason = $2
       LIMIT 1`,
      [accountId, LedgerReason.SIGNUP_GRANT]
    );
    if ((existing.rowCount ?? 0) > 0) {
      const balance = await getBalance(accountId, client);
      return { granted: 0, balance };
    }

    if (grantAmount <= 0) {
      return { granted: 0, balance: 0 };
    }

    const walletLock: QueryResult<{ balance: string }> = await runQuery(
      client,
      `SELECT balance FROM credit_wallets WHERE account_id = $1 FOR UPDATE`,
      [accountId]
    );
    const current: number = asNumber(walletLock.rows[0]?.balance ?? 0);
    const balanceAfter: number = current + grantAmount;

    await runQuery(
      client,
      `INSERT INTO credit_ledger (
         account_id, amount, reason, balance_after,
         reference_type, reference_id
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      [
        accountId,
        grantAmount,
        LedgerReason.SIGNUP_GRANT,
        balanceAfter,
        LedgerReferenceType.SIGNUP,
        accountId,
      ]
    );

    await runQuery(
      client,
      `UPDATE credit_wallets
       SET balance = $2, updated_at = now()
       WHERE account_id = $1`,
      [accountId, balanceAfter]
    );

    return { granted: grantAmount, balance: balanceAfter };
  } catch (error: unknown) {
    logCaught("ledger.service.grantSignupCredits", error);
    throw error;
  }
}

export async function getBalance(accountId: string, client?: PoolClient): Promise<number> {
  try {
    if (!isAccountUuid(accountId)) {
      if (!adminPocBalances.has(accountId)) {
        adminPocBalances.set(accountId, loadEnv().demoStartingCredits);
      }
      return adminPocBalances.get(accountId)!;
    }

    const db: Queryable = client ?? getPool();
    const result: QueryResult<{ balance: string }> = await runQuery(
      db,
      `SELECT balance FROM credit_wallets WHERE account_id = $1`,
      [accountId]
    );
    if (!result.rows[0]) return 0;
    return asNumber(result.rows[0].balance);
  } catch (error: unknown) {
    logCaught("ledger.service.getBalance", error);
    throw error;
  }
}

/**
 * Debits up to `credits` from the account, clamping at zero.
 * Real accounts use Postgres; non-UUID admin POC ids stay in-memory.
 */
export async function debit(
  accountId: string,
  credits: number
): Promise<{ charged: number; balance: number }> {
  try {
    if (!isAccountUuid(accountId)) {
      const current = await getBalance(accountId);
      const charged = Math.min(credits, current);
      const balance = current - charged;
      adminPocBalances.set(accountId, balance);
      return { charged, balance };
    }

    return await withPoolTransaction(async (client: PoolClient) => {
      await ensureWallet(accountId, client);
      const locked: QueryResult<{ balance: string }> = await runQuery(
        client,
        `SELECT balance FROM credit_wallets WHERE account_id = $1 FOR UPDATE`,
        [accountId]
      );
      const current: number = asNumber(locked.rows[0]?.balance ?? 0);
      const charged: number = Math.min(credits, current);
      const balance: number = current - charged;

      if (charged > 0) {
        await runQuery(
          client,
          `INSERT INTO credit_ledger (
             account_id, amount, reason, balance_after, reference_type
           ) VALUES ($1, $2, $3, $4, $5)`,
          [accountId, -charged, LedgerReason.DEBIT, balance, LedgerReferenceType.USAGE_EVENT]
        );
        await runQuery(
          client,
          `UPDATE credit_wallets
           SET balance = $2, updated_at = now()
           WHERE account_id = $1`,
          [accountId, balance]
        );
      }

      return { charged, balance };
    });
  } catch (error: unknown) {
    logCaught("ledger.service.debit", error);
    throw error;
  }
}
