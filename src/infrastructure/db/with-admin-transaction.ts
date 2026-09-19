import type { PoolClient } from "pg";
import { withPoolTransaction } from "./with-transaction";

/**
 * Run work in a transaction with admin RLS GUC context set:
 *   app.is_admin = true
 *   app.admin_id = <admin_users.id>
 *
 * Uses set_config(..., is_local := true) — equivalent to SET LOCAL, safe with
 * PgBouncer transaction pooling. When DATABASE_URL uses a superuser / table
 * owner, RLS is bypassed anyway; this still prepares the app for `app_admin`.
 */
export async function withAdminTransaction<T>(
  adminUserId: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withPoolTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_admin', 'true', true)`);
    await client.query(`SELECT set_config('app.admin_id', $1, true)`, [adminUserId]);
    return work(client);
  });
}
