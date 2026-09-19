import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../../config/app-status-codes";
import { fail } from "../../../shared/http/api-response";
import { getPermissionsForRole } from "../../../modules/admin/admin-auth.service";

declare module "fastify" {
  interface FastifyRequest {
    /** Effective permission keys for request.admin.role (loaded by requirePermission). */
    adminPermissions?: string[];
  }
}

/** Pure check — unit-tested; used by middleware and services. */
export function hasAdminPermission(permissions: readonly string[], required: string): boolean {
  return permissions.includes(required);
}

/**
 * Ensure request.admin holds `permission`.
 * Call after requireAdmin / requireAdminPreHandler so request.admin is set.
 * Loads role_permissions on each call (no session snapshot — revokes take effect next request).
 */
export async function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string
): Promise<boolean> {
  const admin = request.admin;
  if (!admin) {
    fail(reply, AppStatus.ADMIN_AUTH_UNAUTHORIZED, "Unauthorized", 401);
    return false;
  }

  const permissions = await getPermissionsForRole(admin.role);
  request.adminPermissions = permissions;

  if (!hasAdminPermission(permissions, permission)) {
    fail(reply, AppStatus.ADMIN_FORBIDDEN, "Forbidden", 403);
    return false;
  }

  return true;
}

/** Fastify preHandler factory: require a specific permission key. */
export function requirePermissionPreHandler(permission: string) {
  return async function permissionPreHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const ok = await requirePermission(request, reply, permission);
    if (!ok) return;
  };
}
