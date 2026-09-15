import type { PoolClient } from "pg";
import { getPool } from "./pool";

/**
 * Run multiple queries in a single transaction.
 * Use client.query inside the callback — not getPool().query.
 */
export async function withPoolTransaction<T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const result: T = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure; original error is more important
    }
    throw error;
  } finally {
    client.release();
  }
}
