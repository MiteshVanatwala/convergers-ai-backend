import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as adminService from "./admin.service";
import type { Client } from "./admin.service";
import * as usersService from "./users.service";
import type {
  AccountStatus,
  AdminUserListOrder,
  AdminUserListSort,
} from "./users.service";
import * as creditsService from "./credits.service";
import type { LedgerListOrder } from "./credits.service";
import { LEDGER_REASONS } from "./credits.service";
import type { LedgerReasonValue } from "../../config/ledger-reasons";

/** Health stays a thin probe — not wrapped in the API envelope. */
export async function health() {
  return { ok: true };
}

const ACCOUNT_STATUSES: readonly AccountStatus[] = ["active", "suspended", "soft_deleted"];
const USER_SORTS: readonly AdminUserListSort[] = ["created_at", "last_login_at", "email"];

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapUserListItem(row: usersService.AdminUserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.avatar_url,
    authProvider: row.auth_provider,
    status: row.status,
    creditBalance: Number(row.credit_balance),
    lastLoginAt: toIso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
  };
}

function mapUserDetail(row: usersService.AdminUserDetailRow) {
  return {
    ...mapUserListItem(row),
    googleId: row.google_id,
    emailVerifiedAt: toIso(row.email_verified_at),
    riskScore: row.risk_score,
    updatedAt: row.updated_at.toISOString(),
    signupGrantAmount:
      row.signup_grant_amount == null ? null : Number(row.signup_grant_amount),
    signupGrantAt: toIso(row.signup_grant_at),
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function listUsers(
  request: FastifyRequest<{
    Querystring: {
      q?: string;
      status?: string;
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
    if (statusRaw && !(ACCOUNT_STATUSES as readonly string[]).includes(statusRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_USERS_VALIDATION_FAILED,
        "status must be active, suspended, or soft_deleted",
        400
      );
    }

    const sortRaw = request.query.sort?.trim() || "created_at";
    if (!(USER_SORTS as readonly string[]).includes(sortRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_USERS_VALIDATION_FAILED,
        "sort must be created_at, last_login_at, or email",
        400
      );
    }

    const orderRaw = (request.query.order?.trim() || "DESC").toUpperCase();
    if (orderRaw !== "ASC" && orderRaw !== "DESC") {
      return fail(reply, AppStatus.ADMIN_USERS_VALIDATION_FAILED, "order must be ASC or DESC", 400);
    }

    const limitParsed = Number(request.query.limit ?? 50);
    const offsetParsed = Number(request.query.offset ?? 0);
    const limit = Number.isFinite(limitParsed)
      ? Math.min(100, Math.max(1, Math.floor(limitParsed)))
      : 50;
    const offset = Number.isFinite(offsetParsed) ? Math.max(0, Math.floor(offsetParsed)) : 0;

    const result = await usersService.listUsers({
      q: qRaw,
      status: statusRaw as AccountStatus | null,
      limit,
      offset,
      sort: sortRaw as AdminUserListSort,
      order: orderRaw as AdminUserListOrder,
    });

    return ok(reply, AppStatus.ADMIN_USERS_RETRIEVED, {
      items: result.rows.map(mapUserListItem),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error: unknown) {
    logCaught("admin.controller.listUsers", error);
    request.log.error({ err: error }, "[admin.controller.listUsers] failed");
    return fail(reply, AppStatus.ADMIN_USERS_FETCH_FAILED, "Failed to list users", 500);
  }
}

export async function getUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_USERS_VALIDATION_FAILED, "Invalid user id", 400);
    }
    const row = await usersService.getUserById(id);
    if (!row) {
      return fail(reply, AppStatus.ADMIN_USER_NOT_FOUND, "User not found", 404);
    }
    return ok(reply, AppStatus.ADMIN_USER_RETRIEVED, mapUserDetail(row));
  } catch (error: unknown) {
    logCaught("admin.controller.getUser", error);
    request.log.error({ err: error }, "[admin.controller.getUser] failed");
    return fail(reply, AppStatus.ADMIN_USERS_FETCH_FAILED, "Failed to load user", 500);
  }
}

export async function updateUser(
  request: FastifyRequest<{
    Params: { id: string };
    Body: { name?: string | null; status?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_USERS_VALIDATION_FAILED, "Invalid user id", 400);
    }

    const statusRaw = request.body?.status?.trim();
    if (statusRaw !== "active" && statusRaw !== "suspended") {
      return fail(
        reply,
        AppStatus.ADMIN_USERS_VALIDATION_FAILED,
        "status must be active or suspended",
        400
      );
    }

    const nameRaw = request.body?.name;
    const name =
      typeof nameRaw === "string" ? nameRaw.trim() || null : nameRaw === null ? null : undefined;
    if (name === undefined) {
      return fail(reply, AppStatus.ADMIN_USERS_VALIDATION_FAILED, "name is required", 400);
    }

    const existing = await usersService.getUserById(id);
    if (!existing) {
      return fail(reply, AppStatus.ADMIN_USER_NOT_FOUND, "User not found", 404);
    }
    if (existing.status === "soft_deleted") {
      return fail(
        reply,
        AppStatus.ADMIN_USERS_VALIDATION_FAILED,
        "Soft-deleted users cannot be edited",
        400
      );
    }

    const updated = await usersService.updateUser(id, { name, status: statusRaw });
    if (!updated) {
      return fail(reply, AppStatus.ADMIN_USER_NOT_FOUND, "User not found", 404);
    }
    return ok(reply, AppStatus.ADMIN_USER_UPDATED, mapUserDetail(updated));
  } catch (error: unknown) {
    logCaught("admin.controller.updateUser", error);
    request.log.error({ err: error }, "[admin.controller.updateUser] failed");
    return fail(reply, AppStatus.ADMIN_USER_UPDATE_FAILED, "Failed to update user", 500);
  }
}

export async function softDeleteUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_USERS_VALIDATION_FAILED, "Invalid user id", 400);
    }
    const updated = await usersService.softDeleteUser(id);
    if (!updated) {
      return fail(reply, AppStatus.ADMIN_USER_NOT_FOUND, "User not found", 404);
    }
    return ok(reply, AppStatus.ADMIN_USER_SOFT_DELETED, mapUserDetail(updated));
  } catch (error: unknown) {
    logCaught("admin.controller.softDeleteUser", error);
    request.log.error({ err: error }, "[admin.controller.softDeleteUser] failed");
    return fail(reply, AppStatus.ADMIN_USER_DELETE_FAILED, "Failed to delete user", 500);
  }
}

function parseOptionalDate(raw: string | undefined): Date | null | "invalid" {
  if (!raw?.trim()) return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return "invalid";
  return new Date(ms);
}

function mapLedgerItem(row: creditsService.LedgerListRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    name: row.name,
    amount: Number(row.amount),
    reason: row.reason,
    balanceAfter: Number(row.balance_after),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listLedger(
  request: FastifyRequest<{
    Querystring: {
      accountId?: string;
      q?: string;
      reason?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
      order?: string;
    };
  }>,
  reply: FastifyReply
) {
  try {
    const accountIdRaw = request.query.accountId?.trim() || null;
    if (accountIdRaw && !UUID_RE.test(accountIdRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_LEDGER_VALIDATION_FAILED,
        "accountId must be a valid UUID",
        400
      );
    }

    const reasonRaw = request.query.reason?.trim() || null;
    if (reasonRaw && !(LEDGER_REASONS as readonly string[]).includes(reasonRaw)) {
      return fail(
        reply,
        AppStatus.ADMIN_LEDGER_VALIDATION_FAILED,
        `reason must be one of: ${LEDGER_REASONS.join(", ")}`,
        400
      );
    }

    const fromParsed = parseOptionalDate(request.query.from);
    if (fromParsed === "invalid") {
      return fail(
        reply,
        AppStatus.ADMIN_LEDGER_VALIDATION_FAILED,
        "from must be a valid ISO date",
        400
      );
    }
    const toParsed = parseOptionalDate(request.query.to);
    if (toParsed === "invalid") {
      return fail(
        reply,
        AppStatus.ADMIN_LEDGER_VALIDATION_FAILED,
        "to must be a valid ISO date",
        400
      );
    }

    const orderRaw = (request.query.order?.trim() || "DESC").toUpperCase();
    if (orderRaw !== "ASC" && orderRaw !== "DESC") {
      return fail(
        reply,
        AppStatus.ADMIN_LEDGER_VALIDATION_FAILED,
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

    const result = await creditsService.listLedger({
      accountId: accountIdRaw,
      q: request.query.q?.trim() || null,
      reason: reasonRaw as LedgerReasonValue | null,
      from: fromParsed,
      to: toParsed,
      limit,
      offset,
      order: orderRaw as LedgerListOrder,
    });

    return ok(reply, AppStatus.ADMIN_LEDGER_RETRIEVED, {
      items: result.rows.map(mapLedgerItem),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error: unknown) {
    logCaught("admin.controller.listLedger", error);
    request.log.error({ err: error }, "[admin.controller.listLedger] failed");
    return fail(reply, AppStatus.ADMIN_LEDGER_FETCH_FAILED, "Failed to list ledger", 500);
  }
}

export async function listClients(request: FastifyRequest, reply: FastifyReply) {
  try {
    const clients = await adminService.listClientsWithBalances();
    return ok(reply, AppStatus.ADMIN_CLIENTS_RETRIEVED, clients);
  } catch (error: unknown) {
    logCaught("admin.controller.listClients", error);
    request.log.error({ err: error }, "[admin.controller.listClients] failed");
    return fail(reply, AppStatus.ADMIN_CLIENTS_FETCH_FAILED, "Failed to list clients", 500);
  }
}

export async function createClient(
  request: FastifyRequest<{ Body: { name?: string; email?: string; plan?: string } }>,
  reply: FastifyReply
) {
  try {
    const name = request.body?.name?.trim();
    const email = request.body?.email?.trim();
    if (!name || !email) {
      return fail(
        reply,
        AppStatus.ADMIN_CLIENT_VALIDATION_FAILED,
        "name and email are required",
        400
      );
    }
    const requestedPlan = request.body?.plan;
    const plan: Client["plan"] = (adminService.PLANS as readonly string[]).includes(requestedPlan ?? "")
      ? (requestedPlan as Client["plan"])
      : "pay_as_you_go";
    const client = await adminService.createClient({ name, email, plan });
    return ok(reply, AppStatus.ADMIN_CLIENT_CREATED, client, 201);
  } catch (error: unknown) {
    logCaught("admin.controller.createClient", error);
    request.log.error({ err: error }, "[admin.controller.createClient] failed");
    return fail(reply, AppStatus.ADMIN_CLIENT_CREATE_FAILED, "Failed to create client", 500);
  }
}

export async function stats(request: FastifyRequest, reply: FastifyReply) {
  try {
    const summary = adminService.getStats();
    return ok(reply, AppStatus.ADMIN_STATS_RETRIEVED, summary);
  } catch (error: unknown) {
    logCaught("admin.controller.stats", error);
    request.log.error({ err: error }, "[admin.controller.stats] failed");
    return fail(reply, AppStatus.ADMIN_STATS_FETCH_FAILED, "Failed to load stats", 500);
  }
}

export async function listProviders(request: FastifyRequest, reply: FastifyReply) {
  try {
    const providers = adminService.listProviders();
    return ok(reply, AppStatus.ADMIN_PROVIDERS_RETRIEVED, providers);
  } catch (error: unknown) {
    logCaught("admin.controller.listProviders", error);
    request.log.error({ err: error }, "[admin.controller.listProviders] failed");
    return fail(reply, AppStatus.ADMIN_PROVIDERS_FETCH_FAILED, "Failed to list providers", 500);
  }
}

export async function setProviderKey(
  request: FastifyRequest<{ Params: { id: string }; Body: { apiKey?: string } }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey) {
      return fail(
        reply,
        AppStatus.ADMIN_PROVIDER_VALIDATION_FAILED,
        "apiKey is required",
        400
      );
    }
    const result = adminService.setProviderKey(id, apiKey);
    if ("error" in result) {
      return fail(reply, AppStatus.ADMIN_PROVIDER_NOT_FOUND, "Unknown provider", 404);
    }
    return ok(reply, AppStatus.ADMIN_PROVIDER_KEY_SET, {
      id,
      configured: true,
      source: "override" as const,
      maskedKey: adminService.maskProviderKey(apiKey),
    });
  } catch (error: unknown) {
    logCaught("admin.controller.setProviderKey", error);
    request.log.error({ err: error }, "[admin.controller.setProviderKey] failed");
    return fail(reply, AppStatus.ADMIN_PROVIDER_KEY_FAILED, "Failed to set provider key", 500);
  }
}
