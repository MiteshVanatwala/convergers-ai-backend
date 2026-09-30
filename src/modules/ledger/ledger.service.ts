import type { PoolClient, QueryResult } from "pg";
import { loadEnv } from "../../config/env";
import { LedgerReason, LedgerReferenceType } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";

export const CREDITS_PER_USD = 1000;
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

type RecurringGrantPrecheckRow = {
  recurring_grant_credits: number;
  recurring_grant_period_hours: number | null;
  last_recurring_grant_at: Date | null;
};

function grantDue(row: RecurringGrantPrecheckRow): boolean {
  if (row.recurring_grant_credits <= 0 || row.recurring_grant_period_hours == null) return false;
  if (!row.last_recurring_grant_at) return true;
  const dueAt = row.last_recurring_grant_at.getTime() + row.recurring_grant_period_hours * 3_600_000;
  return Date.now() >= dueAt;
}

/**
 * Lazily-evaluated rolling window (not a scheduled/cron reset): tops up an
 * account's wallet if its plan has a recurring grant configured and enough
 * time has passed since it last received one. Cheap no-op in the common
 * case (nothing due) — only opens a locking transaction when a grant looks
 * due, and re-checks under the lock to stay correct under concurrent calls
 * for the same account.
 */
export async function applyDueRecurringGrant(accountId: string): Promise<void> {
  if (!isAccountUuid(accountId)) return;

  try {
    const pool = getPool();
    const precheck: QueryResult<RecurringGrantPrecheckRow> = await runQuery(
      pool,
      `SELECT p.recurring_grant_credits, p.recurring_grant_period_hours, w.last_recurring_grant_at
       FROM account_plans ap
       JOIN plans p ON p.id = ap.plan_id
       LEFT JOIN credit_wallets w ON w.account_id = ap.account_id
       WHERE ap.account_id = $1 AND ap.status = 'active'`,
      [accountId]
    );
    const row = precheck.rows[0];
    if (!row || !grantDue(row)) return;

    await withPoolTransaction(async (client: PoolClient) => {
      await ensureWallet(accountId, client);
      const locked: QueryResult<{
        balance: string;
        recurring_grant_credits: number;
        recurring_grant_period_hours: number | null;
        last_recurring_grant_at: Date | null;
      }> = await runQuery(
        client,
        `SELECT w.balance, p.recurring_grant_credits, p.recurring_grant_period_hours, w.last_recurring_grant_at
         FROM credit_wallets w
         JOIN account_plans ap ON ap.account_id = w.account_id AND ap.status = 'active'
         JOIN plans p ON p.id = ap.plan_id
         WHERE w.account_id = $1
         FOR UPDATE OF w`,
        [accountId]
      );
      const current = locked.rows[0];
      if (!current || !grantDue(current)) return; // another request already applied it

      const balanceAfter = asNumber(current.balance) + current.recurring_grant_credits;
      await runQuery(
        client,
        `INSERT INTO credit_ledger (
           account_id, amount, reason, balance_after, reference_type, reference_id
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        [
          accountId,
          current.recurring_grant_credits,
          LedgerReason.RECURRING_GRANT,
          balanceAfter,
          LedgerReferenceType.RECURRING_GRANT,
          accountId,
        ]
      );
      await runQuery(
        client,
        `UPDATE credit_wallets
         SET balance = $2, last_recurring_grant_at = now(), updated_at = now()
         WHERE account_id = $1`,
        [accountId, balanceAfter]
      );
    });
  } catch (error: unknown) {
    logCaught("ledger.service.applyDueRecurringGrant", error);
    throw error;
  }
}

export async function getBalance(accountId: string, client?: PoolClient): Promise<number> {
  try {
    await applyDueRecurringGrant(accountId);

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
 *
 * Prefer `usage.service.recordSuccessAndDebit` for AI spend so a usage_events
 * row and ledger.reference_id are written in the same transaction.
 */
export async function debit(
  accountId: string,
  credits: number,
  options?: { referenceId?: string | null; client?: PoolClient }
): Promise<{ charged: number; balance: number }> {
  try {
    await applyDueRecurringGrant(accountId);

    if (!isAccountUuid(accountId)) {
      const current = await getBalance(accountId);
      const charged = Math.min(credits, current);
      const balance = current - charged;
      adminPocBalances.set(accountId, balance);
      return { charged, balance };
    }

    const run = async (client: PoolClient): Promise<{ charged: number; balance: number }> => {
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
             account_id, amount, reason, balance_after, reference_type, reference_id
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            accountId,
            -charged,
            LedgerReason.DEBIT,
            balance,
            LedgerReferenceType.USAGE_EVENT,
            options?.referenceId ?? null,
          ]
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
    };

    if (options?.client) {
      return run(options.client);
    }

    return await withPoolTransaction(run);
  } catch (error: unknown) {
    logCaught("ledger.service.debit", error);
    throw error;
  }
}
