import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { loadEnv } from "../../config/env";
import { logCaught } from "../../shared/utils/log";
import { verifyPassword } from "../../shared/utils/password";
import {
  hashAdminToken,
  newAdminSessionToken,
} from "../../shared/utils/admin-session-token";

export type ActiveAdminUser = {
  id: string;
  email: string;
  username: string | null;
  role: string;
  status: string;
  displayName: string | null;
};

type AdminAuthRow = {
  id: string;
  email: string;
  username: string | null;
  role: string;
  status: string;
  display_name: string | null;
  password_hash: string;
};

type AdminSessionRow = {
  id: string;
  email: string;
  username: string | null;
  role: string;
  status: string;
  display_name: string | null;
};

function mapActiveAdmin(row: {
  id: string;
  email: string;
  username: string | null;
  role: string;
  status: string;
  display_name: string | null;
}): ActiveAdminUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    displayName: row.display_name ?? null,
  };
}

export async function findActiveAdminByUsername(
  username: string
): Promise<(ActiveAdminUser & { password_hash: string }) | null> {
  try {
    const pool = getPool();
    const result: QueryResult<AdminAuthRow> = await pool.query<AdminAuthRow>(
      `SELECT id, email, username, role, status, display_name, password_hash
       FROM admin_users
       WHERE username = $1
         AND status = 'active'
         AND password_hash IS NOT NULL`,
      [username]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...mapActiveAdmin(row), password_hash: row.password_hash };
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.findActiveAdminByUsername", error);
    throw error;
  }
}

/** @deprecated Prefer session-based auth; kept only if callers still need email lookup. */
export async function findActiveAdminByEmail(email: string): Promise<ActiveAdminUser | null> {
  try {
    const pool = getPool();
    const result: QueryResult<AdminSessionRow> = await pool.query<AdminSessionRow>(
      `SELECT id, email, username, role, status, display_name
       FROM admin_users
       WHERE email = $1
         AND status = 'active'`,
      [email]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapActiveAdmin(row);
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.findActiveAdminByEmail", error);
    throw error;
  }
}

export async function authenticateAdmin(
  username: string,
  password: string
): Promise<ActiveAdminUser | null> {
  const row = await findActiveAdminByUsername(username);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    displayName: row.displayName,
  };
}

export async function createAdminSession(input: {
  adminUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; sessionId: string }> {
  try {
    const pool = getPool();
    const token = newAdminSessionToken();
    const ttlDays = loadEnv().adminSessionTtlDays;
    const result: QueryResult<{ id: string }> = await pool.query<{ id: string }>(
      `INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, now() + ($3::int * interval '1 day'), $4::inet, $5)
       RETURNING id`,
      [input.adminUserId, hashAdminToken(token), ttlDays, input.ip ?? null, input.userAgent ?? null]
    );
    await pool.query(`UPDATE admin_users SET last_login_at = now() WHERE id = $1`, [
      input.adminUserId,
    ]);
    return { token, sessionId: result.rows[0].id };
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.createAdminSession", error);
    throw error;
  }
}

export async function resolveAdminSession(token: string): Promise<ActiveAdminUser | null> {
  try {
    const pool = getPool();
    const result: QueryResult<AdminSessionRow> = await pool.query<AdminSessionRow>(
      `SELECT
         a.id, a.email, a.username, a.role, a.status, a.display_name
       FROM admin_sessions s
       JOIN admin_users a ON a.id = s.admin_user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND a.status = 'active'
         AND a.username IS NOT NULL`,
      [hashAdminToken(token)]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapActiveAdmin(row);
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.resolveAdminSession", error);
    throw error;
  }
}

export async function revokeAdminSession(token: string): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE admin_sessions SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashAdminToken(token)]
    );
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.revokeAdminSession", error);
    throw error;
  }
}

/**
 * Revoke every active session for an operator (deactivate / password reset).
 * Pass a transaction client when mutating admin_users in the same transaction.
 */
export async function revokeAllSessionsForAdmin(
  adminUserId: string,
  client?: PoolClient
): Promise<number> {
  const db = client ?? getPool();
  try {
    const result = await db.query(
      `UPDATE admin_sessions SET revoked_at = now()
       WHERE admin_user_id = $1 AND revoked_at IS NULL`,
      [adminUserId]
    );
    return result.rowCount ?? 0;
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.revokeAllSessionsForAdmin", error);
    throw error;
  }
}

/** Effective permission keys for a role — read live from role_permissions (not session-cached). */
export async function getPermissionsForRole(role: string): Promise<string[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{ permission_key: string }> = await pool.query<{
      permission_key: string;
    }>(
      `SELECT permission_key
       FROM role_permissions
       WHERE role = $1
       ORDER BY permission_key`,
      [role]
    );
    return result.rows.map((row) => row.permission_key);
  } catch (error: unknown) {
    logCaught("admin.admin-auth.service.getPermissionsForRole", error);
    throw error;
  }
}

export type AdminMeProfile = ActiveAdminUser & {
  permissions: string[];
};

export async function buildAdminMeProfile(admin: ActiveAdminUser): Promise<AdminMeProfile> {
  const permissions = await getPermissionsForRole(admin.role);
  return { ...admin, permissions };
}
