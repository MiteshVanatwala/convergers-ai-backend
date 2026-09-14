import type { QueryResult } from "pg";
import { LedgerReason, type LedgerReasonValue } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export type LedgerListOrder = "ASC" | "DESC";

export const LEDGER_REASONS: readonly LedgerReasonValue[] = Object.values(LedgerReason);

export type LedgerListInput = {
  accountId: string | null;
  q: string | null;
  reason: LedgerReasonValue | null;
  from: Date | null;
  to: Date | null;
  limit: number;
  offset: number;
  order: LedgerListOrder;
};

export type LedgerListRow = {
  id: string;
  account_id: string;
  email: string;
  name: string | null;
  amount: string | number;
  reason: string;
  balance_after: string | number;
  reference_type: string | null;
  reference_id: string | null;
  created_by: string | null;
  created_at: Date;
};

export type LedgerListResult = {
  rows: LedgerListRow[];
  total: number;
  limit: number;
  offset: number;
};

export async function listLedger(input: LedgerListInput): Promise<LedgerListResult> {
  try {
    const pool = getPool();
    const order: LedgerListOrder = input.order === "ASC" ? "ASC" : "DESC";

    const filterParams: [
      string | null,
      string | null,
      string | null,
      Date | null,
      Date | null,
    ] = [input.accountId, input.q, input.reason, input.from, input.to];

    const whereSql = `
      WHERE ($1::uuid IS NULL OR l.account_id = $1)
        AND (
          $2::text IS NULL OR
          a.email ILIKE '%' || $2 || '%' OR
          COALESCE(a.name, '') ILIKE '%' || $2 || '%'
        )
        AND ($3::text IS NULL OR l.reason = $3)
        AND ($4::timestamptz IS NULL OR l.created_at >= $4)
        AND ($5::timestamptz IS NULL OR l.created_at < $5)
    `;

    const countResult: QueryResult<{ total: string }> = await pool.query(
      `SELECT COUNT(*)::text AS total
       FROM credit_ledger l
       JOIN accounts a ON a.id = l.account_id
       ${whereSql}`,
      filterParams
    );
    const total: number = Number(countResult.rows[0]?.total ?? 0);

    const listParams: [
      string | null,
      string | null,
      string | null,
      Date | null,
      Date | null,
      number,
      number,
    ] = [
      input.accountId,
      input.q,
      input.reason,
      input.from,
      input.to,
      input.limit,
      input.offset,
    ];

    const listResult: QueryResult<LedgerListRow> = await pool.query<LedgerListRow>(
      `SELECT
         l.id::text AS id,
         l.account_id,
         a.email,
         a.name,
         l.amount,
         l.reason,
         l.balance_after,
         l.reference_type,
         l.reference_id,
         l.created_by::text AS created_by,
         l.created_at
       FROM credit_ledger l
       JOIN accounts a ON a.id = l.account_id
       ${whereSql}
       ORDER BY l.created_at ${order}, l.id ${order}
       LIMIT $6 OFFSET $7`,
      listParams
    );

    return {
      rows: listResult.rows,
      total,
      limit: input.limit,
      offset: input.offset,
    };
  } catch (error: unknown) {
    logCaught("admin.credits.service.listLedger", error);
    throw error;
  }
}
