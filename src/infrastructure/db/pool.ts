import { Pool } from "pg";
import { loadEnv } from "../../config/env";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const { databaseUrl } = loadEnv();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and set DATABASE_URL " +
        "(Postgres is required for auth, sessions, and admin). See README.md."
    );
  }
  pool = new Pool({ connectionString: databaseUrl });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
