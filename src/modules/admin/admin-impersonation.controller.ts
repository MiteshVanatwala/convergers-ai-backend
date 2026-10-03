import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { primaryWebOrigin } from "../../config/env";
import { fail, ok } from "../../shared/http/api-response";
import { buildSessionCookie } from "../../shared/utils/session-token";
import { logCaught } from "../../shared/utils/log";
import * as impersonationService from "./admin-impersonation.service";
import { ImpersonationError } from "./admin-impersonation.service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(request: FastifyRequest): string | null {
  const forwardedFor: string | string[] | undefined = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.ip || null;
}

export async function impersonate(
  request: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return fail(reply, AppStatus.ADMIN_USER_IMPERSONATE_VALIDATION_FAILED, "Invalid user id", 400);
    }
    const reason = typeof request.body?.reason === "string" ? request.body.reason : "";
    if (!reason.trim()) {
      return fail(
        reply,
        AppStatus.ADMIN_USER_IMPERSONATE_VALIDATION_FAILED,
        "A reason is required to start impersonation",
        400
      );
    }

    const userAgent =
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
    const result = await impersonationService.impersonateUser({
      actorId: request.admin!.id,
      accountId: id,
      reason,
      ip: clientIp(request),
      userAgent,
    });

    reply.header("Set-Cookie", buildSessionCookie(result.token));
    return ok(reply, AppStatus.ADMIN_USER_IMPERSONATE_OK, {
      redirectUrl: primaryWebOrigin(),
      accountEmail: result.accountEmail,
    });
  } catch (error: unknown) {
    if (error instanceof ImpersonationError) {
      switch (error.kind) {
        case "validation":
          return fail(reply, AppStatus.ADMIN_USER_IMPERSONATE_VALIDATION_FAILED, error.message, 400);
        case "not_found":
          return fail(reply, AppStatus.ADMIN_USER_IMPERSONATE_NOT_FOUND, error.message, 404);
      }
    }
    logCaught("admin.admin-impersonation.controller.impersonate", error);
    return fail(reply, AppStatus.ADMIN_USER_IMPERSONATE_FAILED, "Failed to start impersonation", 500);
  }
}
