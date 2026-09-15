import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export type ActiveAdminUser = {
  id: string;
  email: string;
  role: string;
  status: string;
};

/** Resolve an allowlisted, active admin by account email (citext). */
export async function findActiveAdminByEmail(email: string): Promise<ActiveAdminUser | null> {
  try {
    const pool = getPool();
    const params: [string] = [email];
    const result: QueryResult<ActiveAdminUser> = await pool.query<ActiveAdminUser>(
      `SELECT id, email, role, status
       FROM admin_users
       WHERE email = $1
         AND status = 'active'`,
      params
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.findActiveAdminByEmail", error);
    throw error;
  }
}
