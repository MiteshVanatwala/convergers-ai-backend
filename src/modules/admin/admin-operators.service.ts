import type { PoolClient, QueryResult } from "pg";
import { withAdminTransaction } from "../../infrastructure/db/with-admin-transaction";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordPolicy,
} from "../../shared/utils/password";
import { appendAdminAudit } from "./admin-audit.service";
import { revokeAllSessionsForAdmin } from "./admin-auth.service";

export const ADMIN_ROLES = ["support", "ops_business", "engineering_admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type OperatorStatus = "active" | "deactivated";
export type OperatorListSort = "created_at" | "last_login_at" | "username" | "email";
export type OperatorListOrder = "ASC" | "DESC";

export type OperatorActionErrorKind =
  | "validation"
  | "conflict"
  | "not_found"
  | "forbidden";

export class OperatorActionError extends Error {
  constructor(
    message: string,
    readonly kind: OperatorActionErrorKind
  ) {
    super(message);
    this.name = "OperatorActionError";
  }
}

export type OperatorListInput = {
  q: string | null;
  status: OperatorStatus | null;
  role: AdminRole | null;
  limit: number;
  offset: number;
  sort: OperatorListSort;
  order: OperatorListOrder;
};

export type OperatorRow = {
  id: string;
  username: string | null;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  is_bootstrap: boolean;
  invited_by_id: string | null;
  invited_by_username: string | null;
  last_login_at: Date | null;
  created_at: Date;
  deactivated_at: Date | null;
};

export type OperatorListResult = {
  rows: OperatorRow[];
  total: number;
  limit: number;
  offset: number;
};

export type RoleCatalogEntry = {
  key: AdminRole;
  label: string;
  permissions: string[];
};

export type CreateOperatorInput = {
  actorId: string;
  username: string;
  email: string;
  displayName: string | null;
  role: AdminRole;
  temporaryPassword: string | null;
};

export type PatchOperatorInput = {
  actorId: string;
  operatorId: string;
  role: AdminRole | undefined;
  displayName: string | null | undefined;
  email: string | undefined;
  reason: string | null;
};

const ROLE_LABELS: Record<AdminRole, string> = {
  support: "Support",
  ops_business: "Ops / Business",
  engineering_admin: "Engineering Admin",
};

const SORT_COLUMNS: Record<OperatorListSort, string> = {
  created_at: "a.created_at",
  last_login_at: "a.last_login_at",
  username: "a.username",
  email: "a.email",
};

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASON_MIN = 8;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function assertRole(role: string): asserts role is AdminRole {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new OperatorActionError(
      "role must be support, ops_business, or engineering_admin",
      "validation"
    );
  }
}

function assertReason(reason: string | null | undefined, required: boolean): string | null {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    if (required) {
      throw new OperatorActionError(`reason is required (min ${REASON_MIN} characters)`, "validation");
    }
    return null;
  }
  if (trimmed.length < REASON_MIN) {
    throw new OperatorActionError(`reason must be at least ${REASON_MIN} characters`, "validation");
  }
  return trimmed;
}

async function lockOperator(client: PoolClient, operatorId: string): Promise<OperatorRow> {
  const result: QueryResult<{
    id: string;
    username: string | null;
    email: string;
    display_name: string | null;
    role: string;
    status: string;
    is_bootstrap: boolean;
    invited_by: string | null;
    last_login_at: Date | null;
    created_at: Date;
    deactivated_at: Date | null;
  }> = await client.query(
    `SELECT id, username, email, display_name, role, status, is_bootstrap,
            invited_by, last_login_at, created_at, deactivated_at
     FROM admin_users
     WHERE id = $1
     FOR UPDATE`,
    [operatorId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new OperatorActionError("Admin operator not found", "not_found");
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    is_bootstrap: row.is_bootstrap,
    invited_by_id: row.invited_by,
    invited_by_username: null,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    deactivated_at: row.deactivated_at,
  };
}

async function countActiveEngineeringAdmins(client: PoolClient): Promise<number> {
  const result: QueryResult<{ c: string }> = await client.query(
    `SELECT COUNT(*)::text AS c
     FROM admin_users
     WHERE role = 'engineering_admin'
       AND status = 'active'`
  );
  return Number(result.rows[0]?.c ?? 0);
}

async function assertNotLastEngineeringAdmin(
  client: PoolClient,
  target: OperatorRow,
  nextRole: string,
  nextStatus: string
): Promise<void> {
  const wasEng = target.role === "engineering_admin" && target.status === "active";
  const staysEng = nextRole === "engineering_admin" && nextStatus === "active";
  if (!wasEng || staysEng) return;
  const count = await countActiveEngineeringAdmins(client);
  if (count <= 1) {
    throw new OperatorActionError(
      "Cannot remove the last active engineering_admin",
      "forbidden"
    );
  }
}

export async function listOperators(input: OperatorListInput): Promise<OperatorListResult> {
  try {
    const pool = getPool();
    const sortColumn = SORT_COLUMNS[input.sort];
    const order: OperatorListOrder = input.order === "ASC" ? "ASC" : "DESC";
    const filterParams: [string | null, string | null, string | null] = [
      input.q,
      input.status,
      input.role,
    ];
    const whereSql = `
      WHERE ($1::text IS NULL OR a.username ILIKE '%' || $1 || '%'
             OR a.email ILIKE '%' || $1 || '%'
             OR COALESCE(a.display_name, '') ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR a.status = $2)
        AND ($3::text IS NULL OR a.role = $3)
    `;

    const countResult: QueryResult<{ total: string }> = await pool.query(
      `SELECT COUNT(*)::text AS total FROM admin_users a ${whereSql}`,
      filterParams
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const listResult: QueryResult<OperatorRow> = await pool.query(
      `SELECT
         a.id,
         a.username,
         a.email,
         a.display_name,
         a.role,
         a.status,
         a.is_bootstrap,
         a.invited_by AS invited_by_id,
         inv.username AS invited_by_username,
         a.last_login_at,
         a.created_at,
         a.deactivated_at
       FROM admin_users a
       LEFT JOIN admin_users inv ON inv.id = a.invited_by
       ${whereSql}
       ORDER BY ${sortColumn} ${order} NULLS LAST, a.id ASC
       LIMIT $4 OFFSET $5`,
      [...filterParams, input.limit, input.offset]
    );

    return {
      rows: listResult.rows,
      total,
      limit: input.limit,
      offset: input.offset,
    };
  } catch (error: unknown) {
    logCaught("admin.admin-operators.service.listOperators", error);
    throw error;
  }
}

export async function listRoleCatalog(): Promise<RoleCatalogEntry[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{ role: string; permission_key: string }> = await pool.query(
      `SELECT role, permission_key
       FROM role_permissions
       WHERE role = ANY($1::text[])
       ORDER BY role, permission_key`,
      [ADMIN_ROLES as unknown as string[]]
    );

    const byRole = new Map<AdminRole, string[]>();
    for (const role of ADMIN_ROLES) byRole.set(role, []);
    for (const row of result.rows) {
      if (!(ADMIN_ROLES as readonly string[]).includes(row.role)) continue;
      byRole.get(row.role as AdminRole)!.push(row.permission_key);
    }

    return ADMIN_ROLES.map((key) => ({
      key,
      label: ROLE_LABELS[key],
      permissions: byRole.get(key) ?? [],
    }));
  } catch (error: unknown) {
    logCaught("admin.admin-operators.service.listRoleCatalog", error);
    throw error;
  }
}

export async function createOperator(
  input: CreateOperatorInput
): Promise<{ operator: OperatorRow; temporaryPassword: string }> {
  const username = input.username.trim();
  const email = input.email.trim();
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim()
      : null;

  if (!USERNAME_RE.test(username)) {
    throw new OperatorActionError(
      "username must be 3–32 chars: letters, digits, . _ -",
      "validation"
    );
  }
  if (!EMAIL_RE.test(email)) {
    throw new OperatorActionError("email is invalid", "validation");
  }
  assertRole(input.role);

  let temporaryPassword = input.temporaryPassword?.trim() || "";
  if (!temporaryPassword) {
    temporaryPassword = generateTemporaryPassword(20);
  }
  const policyError = validatePasswordPolicy(temporaryPassword);
  if (policyError) {
    throw new OperatorActionError(policyError, "validation");
  }

  const passwordHash = hashPassword(temporaryPassword);

  try {
    return await withAdminTransaction(input.actorId, async (client) => {
      let inserted: {
        id: string;
        username: string | null;
        email: string;
        display_name: string | null;
        role: string;
        status: string;
        is_bootstrap: boolean;
        invited_by: string | null;
        last_login_at: Date | null;
        created_at: Date;
        deactivated_at: Date | null;
      };
      try {
        const result = await client.query<{
          id: string;
          username: string | null;
          email: string;
          display_name: string | null;
          role: string;
          status: string;
          is_bootstrap: boolean;
          invited_by: string | null;
          last_login_at: Date | null;
          created_at: Date;
          deactivated_at: Date | null;
        }>(
          `INSERT INTO admin_users (
             email, username, password_hash, role, status, invited_by,
             display_name, password_changed_at, is_bootstrap
           ) VALUES ($1, $2, $3, $4, 'active', $5, $6, now(), false)
           RETURNING id, username, email, display_name, role, status, is_bootstrap,
                     invited_by, last_login_at, created_at, deactivated_at`,
          [email, username, passwordHash, input.role, input.actorId, displayName]
        );
        inserted = result.rows[0]!;
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw new OperatorActionError("username or email already exists", "conflict");
        }
        throw error;
      }

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "admin_operator.create",
          targetType: "admin_user",
          targetId: inserted.id,
          reason: null,
          meta: { username, email, role: input.role },
        },
        client
      );

      return {
        operator: {
          id: inserted.id,
          username: inserted.username,
          email: inserted.email,
          display_name: inserted.display_name,
          role: inserted.role,
          status: inserted.status,
          is_bootstrap: inserted.is_bootstrap,
          invited_by_id: inserted.invited_by,
          invited_by_username: null,
          last_login_at: inserted.last_login_at,
          created_at: inserted.created_at,
          deactivated_at: inserted.deactivated_at,
        },
        temporaryPassword,
      };
    });
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) throw error;
    logCaught("admin.admin-operators.service.createOperator", error);
    throw error;
  }
}

export async function patchOperator(input: PatchOperatorInput): Promise<OperatorRow> {
  const hasRole = input.role !== undefined;
  const hasDisplayName = input.displayName !== undefined;
  const hasEmail = input.email !== undefined;
  if (!hasRole && !hasDisplayName && !hasEmail) {
    throw new OperatorActionError("no fields to update", "validation");
  }

  if (hasRole) {
    assertRole(input.role!);
  }
  let email: string | undefined;
  if (hasEmail) {
    email = input.email!.trim();
    if (!EMAIL_RE.test(email)) {
      throw new OperatorActionError("email is invalid", "validation");
    }
  }
  const displayName =
    hasDisplayName && typeof input.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim()
      : hasDisplayName
        ? null
        : undefined;

  try {
    return await withAdminTransaction(input.actorId, async (client) => {
      const target = await lockOperator(client, input.operatorId);

      if (hasRole && input.role !== target.role) {
        if (input.actorId === target.id) {
          throw new OperatorActionError("Cannot change your own role", "forbidden");
        }
        if (target.is_bootstrap) {
          throw new OperatorActionError("Cannot change role of bootstrap operator", "forbidden");
        }
        const reason = assertReason(input.reason, true);
        await assertNotLastEngineeringAdmin(client, target, input.role!, target.status);

        try {
          await client.query(
            `UPDATE admin_users SET role = $2 WHERE id = $1`,
            [target.id, input.role]
          );
        } catch (error: unknown) {
          throw error;
        }

        await appendAdminAudit(
          {
            adminUserId: input.actorId,
            action: "admin_operator.role_change",
            targetType: "admin_user",
            targetId: target.id,
            reason,
            meta: { from: target.role, to: input.role },
          },
          client
        );
        target.role = input.role!;
      } else if (hasRole && input.reason) {
        // role unchanged but reason provided — ignore reason
      }

      if (hasEmail || hasDisplayName) {
        const nextEmail = hasEmail ? email! : target.email;
        const nextDisplay =
          hasDisplayName ? (displayName as string | null) : target.display_name;
        try {
          await client.query(
            `UPDATE admin_users
             SET email = $2, display_name = $3
             WHERE id = $1`,
            [target.id, nextEmail, nextDisplay]
          );
        } catch (error: unknown) {
          if (isUniqueViolation(error)) {
            throw new OperatorActionError("username or email already exists", "conflict");
          }
          throw error;
        }
        target.email = nextEmail;
        target.display_name = nextDisplay;
      }

      return target;
    });
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) throw error;
    logCaught("admin.admin-operators.service.patchOperator", error);
    throw error;
  }
}

export async function deactivateOperator(input: {
  actorId: string;
  operatorId: string;
  reason: string;
}): Promise<OperatorRow> {
  const reason = assertReason(input.reason, true)!;

  try {
    return await withAdminTransaction(input.actorId, async (client) => {
      const target = await lockOperator(client, input.operatorId);

      if (input.actorId === target.id) {
        throw new OperatorActionError("Cannot deactivate yourself", "forbidden");
      }
      if (target.is_bootstrap) {
        throw new OperatorActionError("Cannot deactivate bootstrap operator", "forbidden");
      }
      if (target.status === "deactivated") {
        throw new OperatorActionError("Operator is already deactivated", "validation");
      }

      await assertNotLastEngineeringAdmin(client, target, target.role, "deactivated");

      await client.query(
        `UPDATE admin_users
         SET status = 'deactivated', deactivated_at = now()
         WHERE id = $1`,
        [target.id]
      );
      await revokeAllSessionsForAdmin(target.id, client);
      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "admin_operator.deactivate",
          targetType: "admin_user",
          targetId: target.id,
          reason,
          meta: { role: target.role },
        },
        client
      );

      target.status = "deactivated";
      target.deactivated_at = new Date();
      return target;
    });
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) throw error;
    logCaught("admin.admin-operators.service.deactivateOperator", error);
    throw error;
  }
}

export async function reactivateOperator(input: {
  actorId: string;
  operatorId: string;
  reason?: string | null;
}): Promise<OperatorRow> {
  const reason = assertReason(input.reason, false);

  try {
    return await withAdminTransaction(input.actorId, async (client) => {
      const target = await lockOperator(client, input.operatorId);

      if (target.status !== "deactivated") {
        throw new OperatorActionError("Operator is not deactivated", "validation");
      }

      await client.query(
        `UPDATE admin_users
         SET status = 'active', deactivated_at = NULL
         WHERE id = $1`,
        [target.id]
      );
      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "admin_operator.reactivate",
          targetType: "admin_user",
          targetId: target.id,
          reason,
          meta: { role: target.role },
        },
        client
      );

      target.status = "active";
      target.deactivated_at = null;
      return target;
    });
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) throw error;
    logCaught("admin.admin-operators.service.reactivateOperator", error);
    throw error;
  }
}

export async function resetOperatorPassword(input: {
  actorId: string;
  operatorId: string;
  reason: string;
  temporaryPassword?: string | null;
}): Promise<{ operator: OperatorRow; temporaryPassword: string }> {
  const reason = assertReason(input.reason, true)!;

  let temporaryPassword = input.temporaryPassword?.trim() || "";
  if (!temporaryPassword) {
    temporaryPassword = generateTemporaryPassword(20);
  }
  const policyError = validatePasswordPolicy(temporaryPassword);
  if (policyError) {
    throw new OperatorActionError(policyError, "validation");
  }
  const passwordHash = hashPassword(temporaryPassword);

  try {
    return await withAdminTransaction(input.actorId, async (client) => {
      const target = await lockOperator(client, input.operatorId);

      await client.query(
        `UPDATE admin_users
         SET password_hash = $2, password_changed_at = now()
         WHERE id = $1`,
        [target.id, passwordHash]
      );
      await revokeAllSessionsForAdmin(target.id, client);
      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "admin_operator.password_reset",
          targetType: "admin_user",
          targetId: target.id,
          reason,
          meta: {},
        },
        client
      );

      return { operator: target, temporaryPassword };
    });
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) throw error;
    logCaught("admin.admin-operators.service.resetOperatorPassword", error);
    throw error;
  }
}
