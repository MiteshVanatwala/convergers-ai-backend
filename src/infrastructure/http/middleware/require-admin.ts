import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../../config/app-status-codes";
import { fail } from "../../../shared/http/api-response";
import {
  findActiveAdminByEmail,
  type ActiveAdminUser,
} from "../../../modules/admin/admin-auth.service";
import { requireSession } from "./require-session";

declare module "fastify" {
  interface FastifyRequest {
    admin?: ActiveAdminUser;
  }
}

/**
 * Require a valid session whose email is an active row in admin_users.
 * Sends 401 via requireSession when unauthenticated; 403 when not an admin.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<ActiveAdminUser | null> {
  const account = await requireSession(request, reply);
  if (!account) return null;

  const admin = await findActiveAdminByEmail(account.email);
  if (!admin) {
    fail(reply, AppStatus.ADMIN_FORBIDDEN, "Forbidden", 403);
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
