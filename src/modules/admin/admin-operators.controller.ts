import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as operatorsService from "./admin-operators.service";
import type {
  AdminRole,
  OperatorListOrder,
  OperatorListSort,
  OperatorRow,
  OperatorStatus,
} from "./admin-operators.service";
import { ADMIN_ROLES, OperatorActionError } from "./admin-operators.service";

const OPERATOR_STATUSES: readonly OperatorStatus[] = ["active", "deactivated"];
const OPERATOR_SORTS: readonly OperatorListSort[] = [
  "created_at",
  "last_login_at",
  "username",
  "email",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapOperator(row: OperatorRow) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    isBootstrap: row.is_bootstrap,
    invitedBy:
      row.invited_by_id != null
        ? { id: row.invited_by_id, username: row.invited_by_username }
        : null,
    lastLoginAt: toIso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
    deactivatedAt: toIso(row.deactivated_at),
  };
}

function failFromOperatorError(reply: FastifyReply, error: OperatorActionError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED, error.message, 400);
    case "conflict":
      return fail(reply, AppStatus.ADMIN_OPERATOR_CONFLICT, error.message, 409);
    case "not_found":
      return fail(reply, AppStatus.ADMIN_OPERATOR_NOT_FOUND, error.message, 404);
    case "forbidden":
      return fail(reply, AppStatus.ADMIN_OPERATOR_FORBIDDEN_ACTION, error.message, 403);
    default:
      return fail(reply, AppStatus.ADMIN_OPERATOR_UPDATE_FAILED, error.message, 500);
  }
}

export async function listOperators(
  request: FastifyRequest<{
    Querystring: {
      q?: string;
      status?: string;
      role?: string;
      limit?: string;
      offset?: string;
      sort?: string;
      order?: string;
    };
  }>,
  reply: FastifyReply
) {
  try {
    const qRaw = request.query.q?.trim() || null;
    const statusRaw = request.query.status?.trim() || null;
    if (statusRaw && !(OPERATOR_STATUSES as readonly string[]).includes(statusRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED,
        "status must be active or deactivated",
        400
      );
    }

    const roleRaw = request.query.role?.trim() || null;
    if (roleRaw && !(ADMIN_ROLES as readonly string[]).includes(roleRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED,
        "role must be support, ops_business, or engineering_admin",
        400
      );
    }

    const sortRaw = request.query.sort?.trim() || "created_at";
    if (!(OPERATOR_SORTS as readonly string[]).includes(sortRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED,
        "sort must be created_at, last_login_at, username, or email",
        400
      );
    }

    const orderRaw = (request.query.order?.trim() || "DESC").toUpperCase();
    if (orderRaw !== "ASC" && orderRaw !== "DESC") {
      return fail(
        reply,
        AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED,
        "order must be ASC or DESC",
        400
      );
    }

    const limitParsed = Number(request.query.limit ?? 50);
    const offsetParsed = Number(request.query.offset ?? 0);
    const limit = Number.isFinite(limitParsed)
      ? Math.min(100, Math.max(1, Math.floor(limitParsed)))
      : 50;
    const offset = Number.isFinite(offsetParsed) ? Math.max(0, Math.floor(offsetParsed)) : 0;

    const result = await operatorsService.listOperators({
      q: qRaw,
      status: statusRaw as OperatorStatus | null,
      role: roleRaw as AdminRole | null,
      limit,
      offset,
      sort: sortRaw as OperatorListSort,
      order: orderRaw as OperatorListOrder,
    });

    return ok(reply, AppStatus.ADMIN_OPERATORS_RETRIEVED, {
      items: result.rows.map(mapOperator),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error: unknown) {
    logCaught("admin.admin-operators.controller.listOperators", error);
    return fail(reply, AppStatus.ADMIN_OPERATORS_FETCH_FAILED, "Failed to list admins", 500);
  }
}

export async function listRoles(request: FastifyRequest, reply: FastifyReply) {
  try {
    const roles = await operatorsService.listRoleCatalog();
    return ok(reply, AppStatus.ADMIN_OPERATOR_ROLES_RETRIEVED, { roles });
  } catch (error: unknown) {
    logCaught("admin.admin-operators.controller.listRoles", error);
    return fail(reply, AppStatus.ADMIN_OPERATOR_ROLES_FETCH_FAILED, "Failed to list roles", 500);
  }
}

export async function createOperator(
  request: FastifyRequest<{
    Body: {
      username?: string;
      email?: string;
      displayName?: string | null;
      role?: string;
      temporaryPassword?: string;
    };
  }>,
  reply: FastifyReply
) {
  try {
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const email = typeof request.body?.email === "string" ? request.body.email : "";
    const role = typeof request.body?.role === "string" ? request.body.role.trim() : "";
    const displayName =
      request.body?.displayName === null
        ? null
        : typeof request.body?.displayName === "string"
          ? request.body.displayName
          : null;
    const temporaryPassword =
      typeof request.body?.temporaryPassword === "string" ? request.body.temporaryPassword : null;

    if (!username.trim() || !email.trim() || !role) {
      return fail(
        reply,
        AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED,
        "username, email, and role are required",
        400
      );
    }

    const result = await operatorsService.createOperator({
      actorId: request.admin!.id,
      username,
      email,
      displayName,
      role: role as AdminRole,
      temporaryPassword,
    });

    return ok(
      reply,
      AppStatus.ADMIN_OPERATOR_CREATED,
      {
        ...mapOperator(result.operator),
        temporaryPassword: result.temporaryPassword,
      },
      201
    );
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) {
      return failFromOperatorError(reply, error);
    }
    logCaught("admin.admin-operators.controller.createOperator", error);
    return fail(reply, AppStatus.ADMIN_OPERATOR_CREATE_FAILED, "Failed to create admin", 500);
  }
}

export async function patchOperator(
  request: FastifyRequest<{
    Params: { id: string };
    Body: {
      role?: string;
      displayName?: string | null;
      email?: string;
      reason?: string;
    };
  }>,
  reply: FastifyReply
) {
  try {
    const id = request.params.id?.trim() ?? "";
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED, "invalid admin id", 400);
    }

    const body = request.body ?? {};
    const role =
      body.role === undefined
        ? undefined
        : typeof body.role === "string"
          ? (body.role.trim() as AdminRole)
          : undefined;
    const email =
      body.email === undefined
        ? undefined
        : typeof body.email === "string"
          ? body.email
          : undefined;
    const displayName =
      body.displayName === undefined
        ? undefined
        : body.displayName === null
          ? null
          : typeof body.displayName === "string"
            ? body.displayName
            : undefined;
    const reason = typeof body.reason === "string" ? body.reason : null;

    const updated = await operatorsService.patchOperator({
      actorId: request.admin!.id,
      operatorId: id,
      role,
      displayName,
      email,
      reason,
    });

    return ok(reply, AppStatus.ADMIN_OPERATOR_UPDATED, mapOperator(updated));
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) {
      return failFromOperatorError(reply, error);
    }
    logCaught("admin.admin-operators.controller.patchOperator", error);
    return fail(reply, AppStatus.ADMIN_OPERATOR_UPDATE_FAILED, "Failed to update admin", 500);
  }
}

export async function deactivateOperator(
  request: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
  reply: FastifyReply
) {
  try {
    const id = request.params.id?.trim() ?? "";
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED, "invalid admin id", 400);
    }
    const reason = typeof request.body?.reason === "string" ? request.body.reason : "";
    const updated = await operatorsService.deactivateOperator({
      actorId: request.admin!.id,
      operatorId: id,
      reason,
    });
    return ok(reply, AppStatus.ADMIN_OPERATOR_UPDATED, mapOperator(updated));
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) {
      return failFromOperatorError(reply, error);
    }
    logCaught("admin.admin-operators.controller.deactivateOperator", error);
    return fail(reply, AppStatus.ADMIN_OPERATOR_UPDATE_FAILED, "Failed to deactivate admin", 500);
  }
}

export async function reactivateOperator(
  request: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
  reply: FastifyReply
) {
  try {
    const id = request.params.id?.trim() ?? "";
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED, "invalid admin id", 400);
    }
    const reason = typeof request.body?.reason === "string" ? request.body.reason : null;
    const updated = await operatorsService.reactivateOperator({
      actorId: request.admin!.id,
      operatorId: id,
      reason,
    });
    return ok(reply, AppStatus.ADMIN_OPERATOR_UPDATED, mapOperator(updated));
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) {
      return failFromOperatorError(reply, error);
    }
    logCaught("admin.admin-operators.controller.reactivateOperator", error);
    return fail(reply, AppStatus.ADMIN_OPERATOR_UPDATE_FAILED, "Failed to reactivate admin", 500);
  }
}

export async function resetOperatorPassword(
  request: FastifyRequest<{
    Params: { id: string };
    Body: { reason?: string; temporaryPassword?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const id = request.params.id?.trim() ?? "";
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_OPERATOR_VALIDATION_FAILED, "invalid admin id", 400);
    }
    const reason = typeof request.body?.reason === "string" ? request.body.reason : "";
    const temporaryPassword =
      typeof request.body?.temporaryPassword === "string"
        ? request.body.temporaryPassword
        : null;

    const result = await operatorsService.resetOperatorPassword({
      actorId: request.admin!.id,
      operatorId: id,
      reason,
      temporaryPassword,
    });

    return ok(reply, AppStatus.ADMIN_OPERATOR_PASSWORD_RESET, {
      ...mapOperator(result.operator),
      temporaryPassword: result.temporaryPassword,
    });
  } catch (error: unknown) {
    if (error instanceof OperatorActionError) {
      return failFromOperatorError(reply, error);
    }
    logCaught("admin.admin-operators.controller.resetOperatorPassword", error);
    return fail(
      reply,
      AppStatus.ADMIN_OPERATOR_UPDATE_FAILED,
      "Failed to reset admin password",
      500
    );
  }
}
