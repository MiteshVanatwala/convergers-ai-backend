import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export type AccountStatus = "active" | "suspended" | "soft_deleted";

export type AdminUserListSort = "created_at" | "last_login_at" | "email";
export type AdminUserListOrder = "ASC" | "DESC";

export type AdminUserListInput = {
  q: string | null;
  status: AccountStatus | null;
  limit: number;
  offset: number;
  sort: AdminUserListSort;
  order: AdminUserListOrder;
};

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: string;
  status: string;
  credit_balance: string | number;
  last_login_at: Date | null;
  created_at: Date;
};

export type AdminUserDetailRow = AdminUserRow & {
  google_id: string | null;
  email_verified_at: Date | null;
  risk_score: number;
  updated_at: Date;
  signup_grant_amount: string | number | null;
  signup_grant_at: Date | null;
};

export type AdminUserListResult = {
  rows: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
};

export type AdminUserUpdateInput = {
  name: string | null;
  status: "active" | "suspended";
};

const SORT_COLUMNS: Record<AdminUserListSort, string> = {
  created_at: "a.created_at",
  last_login_at: "a.last_login_at",
  email: "a.email",
};

const DETAIL_SELECT = `
  SELECT
    a.id,
    a.email,
    a.name,
    a.avatar_url,
    a.auth_provider,
    a.status,
    a.google_id,
    a.email_verified_at,
    a.risk_score,
    a.updated_at,
    COALESCE(w.balance, 0) AS credit_balance,
    a.last_login_at,
    a.created_at,
    sg.amount AS signup_grant_amount,
    sg.created_at AS signup_grant_at
  FROM accounts a
  LEFT JOIN credit_wallets w ON w.account_id = a.id
  LEFT JOIN LATERAL (
    SELECT amount, created_at
    FROM credit_ledger
    WHERE account_id = a.id AND reason = 'signup_grant'
    ORDER BY created_at ASC
    LIMIT 1
  ) sg ON true
`;

export async function listUsers(input: AdminUserListInput): Promise<AdminUserListResult> {
  try {
    const pool = getPool();
    const sortColumn: string = SORT_COLUMNS[input.sort];
    const order: AdminUserListOrder = input.order === "ASC" ? "ASC" : "DESC";

    const filterParams: [string | null, string | null] = [input.q, input.status];
    const whereSql = `
      WHERE ($1::text IS NULL OR a.email ILIKE '%' || $1 || '%' OR COALESCE(a.name, '') ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR a.status = $2)
    `;

    const countResult: QueryResult<{ total: string }> = await pool.query(
      `SELECT COUNT(*)::text AS total
       FROM accounts a
       ${whereSql}`,
      filterParams
    );
    const total: number = Number(countResult.rows[0]?.total ?? 0);

    const listParams: [string | null, string | null, number, number] = [
      input.q,
      input.status,
      input.limit,
      input.offset,
    ];
    const listResult: QueryResult<AdminUserRow> = await pool.query<AdminUserRow>(
      `SELECT
         a.id,
         a.email,
         a.name,
         a.avatar_url,
         a.auth_provider,
         a.status,
         COALESCE(w.balance, 0) AS credit_balance,
         a.last_login_at,
         a.created_at
       FROM accounts a
       LEFT JOIN credit_wallets w ON w.account_id = a.id
       ${whereSql}
       ORDER BY ${sortColumn} ${order} NULLS LAST
       LIMIT $3 OFFSET $4`,
      listParams
    );

    return {
      rows: listResult.rows,
      total,
      limit: input.limit,
      offset: input.offset,
    };
  } catch (error: unknown) {
    logCaught("admin.users.service.listUsers", error);
    throw error;
  }
}

export async function getUserById(accountId: string): Promise<AdminUserDetailRow | null> {
  try {
    const pool = getPool();
    const result: QueryResult<AdminUserDetailRow> = await pool.query<AdminUserDetailRow>(
      `${DETAIL_SELECT}
       WHERE a.id = $1`,
      [accountId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("admin.users.service.getUserById", error);
    throw error;
  }
}

export async function updateUser(
  accountId: string,
  input: AdminUserUpdateInput
): Promise<AdminUserDetailRow | null> {
  try {
    const pool = getPool();
    const updateResult: QueryResult<{ id: string }> = await pool.query(
      `UPDATE accounts
       SET name = $2,
           status = $3,
           updated_at = now()
       WHERE id = $1
         AND status <> 'soft_deleted'
       RETURNING id`,
      [accountId, input.name, input.status]
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      return null;
    }
    return getUserById(accountId);
  } catch (error: unknown) {
    logCaught("admin.users.service.updateUser", error);
    throw error;
  }
}

export async function softDeleteUser(accountId: string): Promise<AdminUserDetailRow | null> {
  try {
    const pool = getPool();
    const updateResult: QueryResult<{ id: string }> = await pool.query(
      `UPDATE accounts
       SET status = 'soft_deleted',
           updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [accountId]
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      return null;
    }
    return getUserById(accountId);
  } catch (error: unknown) {
    logCaught("admin.users.service.softDeleteUser", error);
    throw error;
  }
}
