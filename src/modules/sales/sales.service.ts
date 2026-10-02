import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";
import { appendAdminAudit } from "../admin/admin-audit.service";

export type SalesInquiryStatus = "new" | "handled";

export const TEAM_SIZE_OPTIONS = ["1–10", "11–50", "51–200", "201–1000", "1000+"] as const;

export type SalesInquiryRow = {
  id: string;
  account_id: string | null;
  name: string;
  email: string;
  company: string;
  phone: string | null;
  team_size: string | null;
  message: string;
  status: SalesInquiryStatus;
  handled_by_label: string | null;
  handled_at: Date | null;
  email_sent_at: Date | null;
  created_at: Date;
};

export type NewSalesInquiry = {
  accountId: string;
  name: string;
  email: string;
  company: string;
  phone: string | null;
  teamSize: string | null;
  message: string;
};

export async function createSalesInquiry(input: NewSalesInquiry): Promise<{ id: string }> {
  try {
    const result: QueryResult<{ id: string }> = await getPool().query(
      `INSERT INTO sales_inquiries (account_id, name, email, company, phone, team_size, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [input.accountId, input.name, input.email, input.company, input.phone, input.teamSize, input.message]
    );
    const row = result.rows[0];
    if (!row) throw new Error("sales_inquiries insert returned no row");
    return row;
  } catch (error: unknown) {
    logCaught("sales.service.createSalesInquiry", error);
    throw error;
  }
}

export async function markSalesInquiryEmailed(id: string): Promise<void> {
  try {
    await getPool().query(`UPDATE sales_inquiries SET email_sent_at = now() WHERE id = $1`, [id]);
  } catch (error: unknown) {
    logCaught("sales.service.markSalesInquiryEmailed", error);
    throw error;
  }
}

/** Newest first; `status` null = all. */
export async function listSalesInquiries(input: {
  status: SalesInquiryStatus | null;
  limit: number;
  offset: number;
}): Promise<{ items: SalesInquiryRow[]; total: number; newCount: number }> {
  try {
    const pool = getPool();
    const [rows, counts]: [
      QueryResult<SalesInquiryRow>,
      QueryResult<{ total: string; new_count: string }>,
    ] = await Promise.all([
      pool.query(
        `SELECT s.id::text AS id, s.account_id::text AS account_id, s.name, s.email, s.company, s.phone,
                s.team_size, s.message, s.status,
                COALESCE(a.display_name, a.username, a.email) AS handled_by_label,
                s.handled_at, s.email_sent_at, s.created_at
         FROM sales_inquiries s
         LEFT JOIN admin_users a ON a.id = s.handled_by
         WHERE ($1::text IS NULL OR s.status = $1)
         ORDER BY s.created_at DESC
         LIMIT $2 OFFSET $3`,
        [input.status, input.limit, input.offset]
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE $1::text IS NULL OR status = $1)::text AS total,
                COUNT(*) FILTER (WHERE status = 'new')::text AS new_count
         FROM sales_inquiries`,
        [input.status]
      ),
    ]);
    return {
      items: rows.rows,
      total: Number(counts.rows[0]?.total ?? 0),
      newCount: Number(counts.rows[0]?.new_count ?? 0),
    };
  } catch (error: unknown) {
    logCaught("sales.service.listSalesInquiries", error);
    throw error;
  }
}

/** Sets new/handled and records who did it in the admin audit log. False if the inquiry doesn't exist. */
export async function setSalesInquiryStatus(input: {
  id: string;
  status: SalesInquiryStatus;
  adminId: string;
}): Promise<boolean> {
  try {
    return await withPoolTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE sales_inquiries
         SET status = $2,
             handled_by = CASE WHEN $2 = 'handled' THEN $3::uuid ELSE NULL END,
             handled_at = CASE WHEN $2 = 'handled' THEN now() ELSE NULL END
         WHERE id = $1`,
        [input.id, input.status, input.adminId]
      );
      if ((updated.rowCount ?? 0) === 0) return false;
      await appendAdminAudit(
        {
          adminUserId: input.adminId,
          action: input.status === "handled" ? "sales_inquiry.handled" : "sales_inquiry.reopened",
          targetType: "sales_inquiry",
          targetId: input.id,
        },
        client
      );
      return true;
    });
  } catch (error: unknown) {
    logCaught("sales.service.setSalesInquiryStatus", error);
    throw error;
  }
}
