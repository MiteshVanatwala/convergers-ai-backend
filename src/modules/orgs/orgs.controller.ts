import type { FastifyReply, FastifyRequest } from "fastify";
import { PAYMENTS_UNAVAILABLE_MESSAGE, isPaymentsUnavailable } from "../billing/razorpay-client";
import { AppStatus } from "../../config/app-status-codes";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import {
  canChangeRole,
  canInvite,
  canLeave,
  canManageOrg,
  canRemoveMember,
  isAdmin,
  isOrgRole,
  type InvitableRole,
  type OrgRole,
} from "./orgs.permissions";
import * as orgsService from "./orgs.service";
import { OrgError } from "./orgs.service";
import {
  MAX_TEAM_SEATS,
  SubscriptionError,
  cancelUnpaidRazorpaySubscriptions,
  changeTeamSeats,
  createTeamSubscription,
} from "../billing/subscription.service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function failFromOrgError(reply: FastifyReply, error: OrgError) {
  switch (error.kind) {
    case "already_member":
    case "already_invited":
      return fail(reply, AppStatus.ORG_CONFLICT, error.message, 409);
    case "invite_not_found":
      return fail(reply, AppStatus.ORG_NOT_FOUND, error.message, 404);
    case "invite_expired":
      return fail(reply, AppStatus.ORG_CONFLICT, error.message, 410);
    case "invite_wrong_account":
      return fail(reply, AppStatus.ORG_FORBIDDEN, error.message, 403);
    case "no_seats":
    case "not_set_up":
    case "has_plan":
    case "has_history":
      return fail(reply, AppStatus.ORG_CONFLICT, error.message, 409);
    case "org_not_found":
      return fail(reply, AppStatus.ORG_NOT_FOUND, error.message, 404);
  }
}

function mapInvite(row: orgsService.InviteRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

/** GET /v1/org — the caller's org (members, open invites for admins) or, if none, invites waiting for them. */
export async function getMyOrg(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) {
      const pending = await orgsService.listPendingInvitesForEmail(account.email);
      return ok(reply, AppStatus.ORG_RETRIEVED, {
        org: null,
        members: [],
        invites: [],
        pendingInvites: pending.map((row) => ({
          ...mapInvite(row),
          orgName: row.org_name,
          invitedBy: row.inviter_name?.trim() || row.inviter_email,
        })),
      });
    }

    const [org, members, invites, poolBalance, spend, subscription, seatsUsed] = await Promise.all([
      orgsService.getOrg(membership.orgId),
      orgsService.listMembers(membership.orgId),
      isAdmin(membership.role) ? orgsService.listOpenInvites(membership.orgId) : Promise.resolve([]),
      orgsService.getPoolBalance(membership.orgId),
      orgsService.getMemberSpendThisMonth(membership.orgId),
      orgsService.getOrgSubscription(membership.orgId),
      orgsService.countSeatsUsed(membership.orgId),
    ]);
    if (!org) return fail(reply, AppStatus.ORG_NOT_FOUND, "Organization not found", 404);

    return ok(reply, AppStatus.ORG_RETRIEVED, {
      org: {
        id: org.id,
        name: org.name,
        myRole: membership.role,
        enforceSensitiveFilter: org.enforce_sensitive_filter,
        allowedModelIds: org.allowed_model_ids,
        seats: org.seats,
        seatsUsed,
        subscription: subscription
          ? {
              status: subscription.status,
              seats: subscription.seats,
              pendingSeats: subscription.pendingSeats,
              currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
            }
          : null,
        poolBalance,
        createdAt: org.created_at.toISOString(),
      },
      members: members.map((m) => ({
        accountId: m.account_id,
        email: m.email,
        name: m.name,
        pictureUrl: m.avatar_url,
        role: m.role,
        monthlyCreditLimit: m.monthly_credit_limit,
        spentThisMonth: spend.get(m.account_id) ?? 0,
        joinedAt: m.joined_at?.toISOString() ?? null,
        isYou: m.account_id === account.id,
      })),
      invites: invites.map(mapInvite),
      pendingInvites: [],
    });
  } catch (error: unknown) {
    logCaught("orgs.controller.getMyOrg", error);
    request.log.error({ err: error }, "[orgs.controller.getMyOrg] failed");
    return fail(reply, AppStatus.ORG_FETCH_FAILED, "Failed to load organization", 500);
  }
}

/**
 * DELETE /v1/org — the owner cancels an org that never finished Team setup.
 * Orgs are created only by Team checkout (startSubscription), so this is the
 * way out of an abandoned checkout.
 */
export async function deleteOrg(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (membership.role !== "owner") {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only the owner can cancel the organization's setup.", 403);
    }
    const { pendingRazorpaySubscriptionIds } = await orgsService.deleteUnpaidOrg(membership.orgId);
    await cancelUnpaidRazorpaySubscriptions(pendingRazorpaySubscriptionIds);
    return ok(reply, AppStatus.ORG_DELETED, { ok: true });
  } catch (error: unknown) {
    if (error instanceof OrgError) return failFromOrgError(reply, error);
    logCaught("orgs.controller.deleteOrg", error);
    request.log.error({ err: error }, "[orgs.controller.deleteOrg] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to cancel organization setup", 500);
  }
}

export async function renameOrg(
  request: FastifyRequest<{ Body: { name?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (!canManageOrg(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can rename the organization.", 403);
    }
    const name = typeof request.body?.name === "string" ? orgsService.normalizeOrgName(request.body.name) : null;
    if (!name) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "Name must be 1–80 characters", 400);
    }
    await orgsService.renameOrg(membership.orgId, name);
    return ok(reply, AppStatus.ORG_UPDATED, { name });
  } catch (error: unknown) {
    logCaught("orgs.controller.renameOrg", error);
    request.log.error({ err: error }, "[orgs.controller.renameOrg] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to rename organization", 500);
  }
}

export async function createInvite(
  request: FastifyRequest<{ Body: { email?: string; role?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);

    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "Enter a valid email address.", 400);
    }
    const role: InvitableRole = request.body?.role === "admin" ? "admin" : "member";
    if (!canInvite(membership.role, role)) {
      return fail(
        reply,
        AppStatus.ORG_FORBIDDEN,
        role === "admin" ? "Only the owner can invite admins." : "Only admins can invite people.",
        403
      );
    }
    if (await orgsService.isEmailMember(membership.orgId, email)) {
      return fail(reply, AppStatus.ORG_CONFLICT, "That person is already a member.", 409);
    }
    // Invites need a paid Team plan; every member and open invite takes a seat.
    const org = await orgsService.getOrg(membership.orgId);
    if (!org) return fail(reply, AppStatus.ORG_NOT_FOUND, "Organization not found", 404);
    if (org.seats === 0) {
      return fail(reply, AppStatus.ORG_CONFLICT, "Subscribe to the Team plan before inviting people.", 409);
    }
    if ((await orgsService.countSeatsUsed(membership.orgId)) >= org.seats) {
      return fail(
        reply,
        AppStatus.ORG_CONFLICT,
        `All ${org.seats} seats are in use (members and pending invites). Revoke an invite or add seats.`,
        409
      );
    }

    const invite = await orgsService.createInvite({
      orgId: membership.orgId,
      email,
      role,
      invitedBy: account.id,
    });
    return ok(reply, AppStatus.ORG_INVITE_CREATED, mapInvite(invite), 201);
  } catch (error: unknown) {
    if (error instanceof OrgError) return failFromOrgError(reply, error);
    logCaught("orgs.controller.createInvite", error);
    request.log.error({ err: error }, "[orgs.controller.createInvite] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to create invite", 500);
  }
}

export async function revokeInvite(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (!canManageOrg(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can revoke invites.", 403);
    }
    const revoked = await orgsService.revokeInvite(membership.orgId, request.params.id);
    if (!revoked) return fail(reply, AppStatus.ORG_NOT_FOUND, "Invite not found.", 404);
    return ok(reply, AppStatus.ORG_INVITE_REVOKED, { ok: true });
  } catch (error: unknown) {
    logCaught("orgs.controller.revokeInvite", error);
    request.log.error({ err: error }, "[orgs.controller.revokeInvite] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to revoke invite", 500);
  }
}

export async function acceptInvite(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const result = await orgsService.acceptInvite({
      inviteId: request.params.id,
      accountId: account.id,
      email: account.email,
    });
    return ok(reply, AppStatus.ORG_INVITE_ACCEPTED, result);
  } catch (error: unknown) {
    if (error instanceof OrgError) return failFromOrgError(reply, error);
    logCaught("orgs.controller.acceptInvite", error);
    request.log.error({ err: error }, "[orgs.controller.acceptInvite] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to accept invite", 500);
  }
}

export async function declineInvite(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const declined = await orgsService.declineInvite(request.params.id, account.email);
    if (!declined) return fail(reply, AppStatus.ORG_NOT_FOUND, "Invite not found.", 404);
    return ok(reply, AppStatus.ORG_INVITE_DECLINED, { ok: true });
  } catch (error: unknown) {
    logCaught("orgs.controller.declineInvite", error);
    request.log.error({ err: error }, "[orgs.controller.declineInvite] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to decline invite", 500);
  }
}

const MAX_MONTHLY_LIMIT = 100_000_000;

/** PATCH a member: `role` (owner only) and/or `monthlyCreditLimit` (admins; null = no limit). */
export async function updateMember(
  request: FastifyRequest<{
    Params: { accountId: string };
    Body: { role?: string; monthlyCreditLimit?: number | null };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);

    const body = request.body ?? {};
    const hasRole = body.role !== undefined;
    const hasLimit = "monthlyCreditLimit" in body;
    if (!hasRole && !hasLimit) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "role or monthlyCreditLimit is required", 400);
    }

    const target = await orgsService.getMembership(request.params.accountId);
    if (!target || target.orgId !== membership.orgId) {
      return fail(reply, AppStatus.ORG_NOT_FOUND, "Member not found.", 404);
    }

    if (hasRole) {
      const newRole = body.role;
      if (!isOrgRole(newRole) || newRole === "billing") {
        return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "role must be admin or member", 400);
      }
      if (
        !canChangeRole(membership.role, account.id, { accountId: request.params.accountId, role: target.role }, newRole)
      ) {
        return fail(reply, AppStatus.ORG_FORBIDDEN, "Only the owner can change other members' roles.", 403);
      }
    }

    let limit: number | null = null;
    if (hasLimit) {
      if (!canManageOrg(membership.role)) {
        return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can set credit limits.", 403);
      }
      const raw = body.monthlyCreditLimit;
      if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_MONTHLY_LIMIT)) {
        return fail(
          reply,
          AppStatus.ORG_VALIDATION_FAILED,
          "monthlyCreditLimit must be a whole number of credits, or null for no limit",
          400
        );
      }
      limit = raw ?? null;
    }

    if (hasRole) {
      await orgsService.updateMemberRole(membership.orgId, request.params.accountId, body.role as OrgRole);
    }
    if (hasLimit) {
      await orgsService.setMemberCreditLimit(membership.orgId, request.params.accountId, limit);
    }
    return ok(reply, AppStatus.ORG_MEMBER_UPDATED, { accountId: request.params.accountId });
  } catch (error: unknown) {
    logCaught("orgs.controller.updateMember", error);
    request.log.error({ err: error }, "[orgs.controller.updateMember] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to update member", 500);
  }
}

/** PATCH /v1/org/settings — admin policies that apply to every member's requests. */
export async function updateSettings(
  request: FastifyRequest<{
    Body: { enforceSensitiveFilter?: boolean; allowedModelIds?: string[] | null };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (!canManageOrg(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can change organization settings.", 403);
    }

    const body = request.body ?? {};
    const input: { enforceSensitiveFilter?: boolean; allowedModelIds?: string[] | null } = {};
    if (body.enforceSensitiveFilter !== undefined) {
      if (typeof body.enforceSensitiveFilter !== "boolean") {
        return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "enforceSensitiveFilter must be a boolean", 400);
      }
      input.enforceSensitiveFilter = body.enforceSensitiveFilter;
    }
    if ("allowedModelIds" in body) {
      const ids = body.allowedModelIds;
      if (ids !== null) {
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) {
          return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "allowedModelIds must be a list of model ids, or null", 400);
        }
        if (ids.length === 0) {
          return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "Allow at least one model.", 400);
        }
      }
      input.allowedModelIds = ids === null ? null : [...new Set(ids)];
    }
    if (Object.keys(input).length === 0) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "No settings to update", 400);
    }

    await orgsService.updateOrgSettings(membership.orgId, input);
    return ok(reply, AppStatus.ORG_UPDATED, input);
  } catch (error: unknown) {
    logCaught("orgs.controller.updateSettings", error);
    request.log.error({ err: error }, "[orgs.controller.updateSettings] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to update settings", 500);
  }
}

/**
 * POST /v1/org/subscription { seats } — starts Team plan checkout for the org
 * (admins). The client then opens Razorpay Checkout and confirms via
 * POST /v1/billing/subscriptions/:id/verify, same as Pro.
 */
export async function startSubscription(
  request: FastifyRequest<{ Body: { seats?: number; orgName?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    let membership = await orgsService.getMembership(account.id);
    if (!membership) {
      // Buying Team from the pricing page without an org: create it (caller = owner)
      // from the company name on the billing step — no separate "create org" step.
      const name =
        typeof request.body?.orgName === "string" ? orgsService.normalizeOrgName(request.body.orgName) : null;
      if (!name) {
        return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization — give it a name to create one.", 404);
      }
      const org = await orgsService.createOrg(account.id, name);
      membership = { orgId: org.id, role: "owner" };
    }
    if (!canManageOrg(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can manage the Team plan.", 403);
    }
    const seats = request.body?.seats;
    if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1 || seats > MAX_TEAM_SEATS) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, `Seats must be between 1 and ${MAX_TEAM_SEATS}.`, 400);
    }
    const used = await orgsService.countSeatsUsed(membership.orgId);
    if (seats < used) {
      return fail(
        reply,
        AppStatus.ORG_VALIDATION_FAILED,
        `You have ${used} members and pending invites — choose at least ${used} seats.`,
        400
      );
    }
    const result = await createTeamSubscription(membership.orgId, seats);
    return ok(reply, AppStatus.ORG_UPDATED, result, 201);
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) {
      return fail(reply, AppStatus.ORG_CONFLICT, error.message, error.kind === "not_found" ? 404 : 409);
    }
    if (error instanceof OrgError) return failFromOrgError(reply, error);
    logCaught("orgs.controller.startSubscription", error);
    request.log.error({ err: error }, "[orgs.controller.startSubscription] failed");
    if (isPaymentsUnavailable(error)) {
      return fail(reply, AppStatus.BILLING_PAYMENTS_UNAVAILABLE, PAYMENTS_UNAVAILABLE_MESSAGE, 503);
    }
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to start Team plan checkout", 500);
  }
}

/** PATCH /v1/org/subscription { seats } — change the seat count of the active Team plan (admins). */
export async function changeSeats(
  request: FastifyRequest<{ Body: { seats?: number } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (!canManageOrg(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can change seats.", 403);
    }
    const seats = request.body?.seats;
    if (typeof seats !== "number") {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "seats is required", 400);
    }
    const used = await orgsService.countSeatsUsed(membership.orgId);
    const result = await changeTeamSeats(membership.orgId, seats, used);
    return ok(reply, AppStatus.ORG_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) {
      return fail(
        reply,
        error.kind === "not_found" ? AppStatus.ORG_NOT_FOUND : AppStatus.ORG_VALIDATION_FAILED,
        error.message,
        error.kind === "not_found" ? 404 : 400
      );
    }
    logCaught("orgs.controller.changeSeats", error);
    request.log.error({ err: error }, "[orgs.controller.changeSeats] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to change seats", 500);
  }
}

const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 366;

/** GET /v1/org/usage?from=&to= — org-wide usage and masking report (admins). Defaults to the last 30 days. */
export async function getUsage(
  request: FastifyRequest<{ Querystring: { from?: string; to?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (!canManageOrg(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "Only admins can see organization usage.", 403);
    }

    const to = request.query.to ? new Date(request.query.to) : new Date();
    const from = request.query.from
      ? new Date(request.query.from)
      : new Date(to.getTime() - DEFAULT_USAGE_DAYS * 86_400_000);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "Invalid from/to (use ISO-8601, from before to)", 400);
    }
    if (to.getTime() - from.getTime() > MAX_USAGE_DAYS * 86_400_000) {
      return fail(reply, AppStatus.ORG_VALIDATION_FAILED, "Range can be at most one year", 400);
    }

    const report = await orgsService.getOrgUsage(membership.orgId, from, to);
    return ok(reply, AppStatus.ORG_RETRIEVED, report);
  } catch (error: unknown) {
    logCaught("orgs.controller.getUsage", error);
    request.log.error({ err: error }, "[orgs.controller.getUsage] failed");
    return fail(reply, AppStatus.ORG_FETCH_FAILED, "Failed to load organization usage", 500);
  }
}

export async function removeMember(
  request: FastifyRequest<{ Params: { accountId: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    const target = await orgsService.getMembership(request.params.accountId);
    if (!target || target.orgId !== membership.orgId) {
      return fail(reply, AppStatus.ORG_NOT_FOUND, "Member not found.", 404);
    }
    if (!canRemoveMember(membership.role, account.id, { accountId: request.params.accountId, role: target.role })) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "You can't remove this member.", 403);
    }
    await orgsService.removeMember(membership.orgId, request.params.accountId);
    return ok(reply, AppStatus.ORG_MEMBER_REMOVED, { ok: true });
  } catch (error: unknown) {
    logCaught("orgs.controller.removeMember", error);
    request.log.error({ err: error }, "[orgs.controller.removeMember] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to remove member", 500);
  }
}

export async function leaveOrg(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await orgsService.getMembership(account.id);
    if (!membership) return fail(reply, AppStatus.ORG_NOT_FOUND, "You're not in an organization.", 404);
    if (!canLeave(membership.role)) {
      return fail(reply, AppStatus.ORG_FORBIDDEN, "The owner can't leave the organization.", 403);
    }
    await orgsService.removeMember(membership.orgId, account.id);
    return ok(reply, AppStatus.ORG_LEFT, { ok: true });
  } catch (error: unknown) {
    logCaught("orgs.controller.leaveOrg", error);
    request.log.error({ err: error }, "[orgs.controller.leaveOrg] failed");
    return fail(reply, AppStatus.ORG_UPDATE_FAILED, "Failed to leave organization", 500);
  }
}
