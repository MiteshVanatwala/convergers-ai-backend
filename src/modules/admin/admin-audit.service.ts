import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export type AdminAuditAppendInput = {
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  /** Structured detail only — never passwords or password hashes. */
  meta?: Record<string, unknown>;
};

type Queryable = {
  query: PoolClient["query"];
};

/**
 * Append-only admin audit writer.
 * Prefer calling inside `withPoolTransaction` with the same client as the mutation.
 */
export async function appendAdminAudit(
  input: AdminAuditAppendInput,
  client?: PoolClient
): Promise<void> {
  const db: Queryable = client ?? getPool();
  try {
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, reason, meta)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.adminUserId,
        input.action,
        input.targetType,
        input.targetId,
        input.reason ?? null,
        JSON.stringify(input.meta ?? {}),
      ]
    );
  } catch (error: unknown) {
    logCaught("admin.admin-audit.service.appendAdminAudit", error);
    throw error;
  }
}

/** Convenience read for local verification / future audit UI. */
export async function listRecentAdminAudit(limit: number = 50): Promise<
  Array<{
    id: string;
    admin_user_id: string;
    action: string;
    target_type: string;
    target_id: string;
    reason: string | null;
    meta: Record<string, unknown>;
    created_at: Date;
  }>
> {
  try {
    const pool = getPool();
    const capped = Math.min(Math.max(1, limit), 200);
    const result: QueryResult<{
      id: string;
      admin_user_id: string;
      action: string;
      target_type: string;
      target_id: string;
      reason: string | null;
      meta: Record<string, unknown>;
      created_at: Date;
    }> = await pool.query(
      `SELECT id, admin_user_id, action, target_type, target_id, reason, meta, created_at
       FROM admin_audit_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [capped]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("admin.admin-audit.service.listRecentAdminAudit", error);
    throw error;
  }
}
