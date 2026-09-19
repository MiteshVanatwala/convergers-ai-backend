import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../../config/app-status-codes";
import { fail } from "../../../shared/http/api-response";
import {
  clearAdminSessionCookie,
  readAdminSessionToken,
} from "../../../shared/utils/admin-session-token";
import {
  resolveAdminSession,
  type ActiveAdminUser,
} from "../../../modules/admin/admin-auth.service";

declare module "fastify" {
  interface FastifyRequest {
    admin?: ActiveAdminUser;
  }
}

/**
 * Require a valid admin session cookie for an active admin_users row.
 * Independent of web Google sessions.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<ActiveAdminUser | null> {
  const token = readAdminSessionToken(request.headers.cookie);
  if (!token) {
    fail(reply, AppStatus.ADMIN_AUTH_UNAUTHORIZED, "Unauthorized", 401);
    return null;
  }

  const admin = await resolveAdminSession(token);
  if (!admin) {
    reply.header("Set-Cookie", clearAdminSessionCookie());
    fail(reply, AppStatus.ADMIN_AUTH_UNAUTHORIZED, "Unauthorized", 401);
    return null;
  }

  request.admin = admin;
  return admin;
}

/** Fastify preHandler that stops the chain when requireAdmin fails. */
export async function requireAdminPreHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const admin = await requireAdmin(request, reply);
  if (!admin) return;
}
