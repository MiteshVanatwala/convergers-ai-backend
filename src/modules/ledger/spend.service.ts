import type { PoolClient, QueryResult } from "pg";
import { LedgerReason } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import { getBalance } from "./ledger.service";

/**
 * Whose credits a request spends. Members of an organization spend its shared
 * pool (subject to their monthly limit); everyone else spends their own wallet.
 */
export type SpendContext =
  | { kind: "personal"; accountId: string }
  | {
      kind: "org";
      accountId: string;
      orgId: string;
      orgName: string;
      role: string;
      /** Credits this member may spend per calendar month; null = no limit. */
      monthlyLimit: number | null;
    };

export type Spendable = {
  context: SpendContext;
  /** What the account can spend right now. */
  balance: number;
  /** Org only. */
  poolBalance?: number;
  spentThisMonth?: number;
  /** Org only, when balance is 0: what ran out. */
  limitedBy?: "pool" | "member_limit";
};

type Queryable = PoolClient | ReturnType<typeof getPool>;

export async function getSpendContext(accountId: string, db: Queryable = getPool()): Promise<SpendContext> {
  try {
    const result: QueryResult<{
      org_id: string;
      org_name: string;
      role: string;
      monthly_credit_limit: number | null;
    }> = await db.query(
      `SELECT m.org_id::text AS org_id, o.name AS org_name, m.role, m.monthly_credit_limit
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
       WHERE m.account_id::text = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return { kind: "personal", accountId };
    return {
      kind: "org",
      accountId,
      orgId: row.org_id,
      orgName: row.org_name,
      role: row.role,
      monthlyLimit: row.monthly_credit_limit,
    };
  } catch (error: unknown) {
    logCaught("ledger.spend.service.getSpendContext", error);
    throw error;
  }
}

/** Credits this member has spent from the org pool since the start of the calendar month. */
export async function getMemberSpentThisMonth(
  orgId: string,
  accountId: string,
  db: Queryable = getPool()
): Promise<number> {
  try {
    const result: QueryResult<{ spent: string }> = await db.query(
      `SELECT COALESCE(-SUM(amount), 0)::text AS spent
       FROM credit_ledger
       WHERE org_id = $1 AND account_id = $2 AND reason = $3
         AND created_at >= date_trunc('month', now())`,
      [orgId, accountId, LedgerReason.DEBIT]
    );
    return Number(result.rows[0]?.spent ?? 0);
  } catch (error: unknown) {
    logCaught("ledger.spend.service.getMemberSpentThisMonth", error);
    throw error;
  }
}

export async function getOrgPoolBalance(orgId: string, db: Queryable = getPool()): Promise<number> {
  try {
    const result: QueryResult<{ balance: string }> = await db.query(
      `SELECT balance FROM org_credit_wallets WHERE org_id = $1`,
      [orgId]
    );
    return Number(result.rows[0]?.balance ?? 0);
  } catch (error: unknown) {
    logCaught("ledger.spend.service.getOrgPoolBalance", error);
    throw error;
  }
}

/** Remaining room under a member's monthly limit (Infinity when there's no limit). */
export function remainingUnderLimit(monthlyLimit: number | null, spentThisMonth: number): number {
  return monthlyLimit == null ? Number.POSITIVE_INFINITY : Math.max(0, monthlyLimit - spentThisMonth);
}

/** What the account can spend right now, from whichever wallet it uses. */
export async function getSpendable(accountId: string): Promise<Spendable> {
  try {
    const context = await getSpendContext(accountId);
    if (context.kind === "personal") {
      return { context, balance: await getBalance(accountId) };
    }

    const [poolBalance, spentThisMonth] = await Promise.all([
      getOrgPoolBalance(context.orgId),
      getMemberSpentThisMonth(context.orgId, accountId),
    ]);
    const room = remainingUnderLimit(context.monthlyLimit, spentThisMonth);
    const balance = Math.max(0, Math.min(poolBalance, room));
    return {
      context,
      balance,
      poolBalance,
      spentThisMonth,
      ...(balance <= 0 ? { limitedBy: room <= 0 ? ("member_limit" as const) : ("pool" as const) } : {}),
    };
  } catch (error: unknown) {
    logCaught("ledger.spend.service.getSpendable", error);
    throw error;
  }
}
