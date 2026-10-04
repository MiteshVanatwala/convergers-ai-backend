import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../../config/app-status-codes";
import { fail } from "../../../shared/http/api-response";
import { clearSessionCookie, readSessionToken } from "../../../shared/utils/session-token";
import { resolveSession } from "../../../modules/auth/auth.service";
import type { SessionAccount } from "../../../modules/auth/types";

declare module "fastify" {
  interface FastifyRequest {
    account?: SessionAccount;
  }
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionAccount | null> {
  const token: string | null = readSessionToken(request.headers.cookie);
  if (!token) {
    fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    return null;
  }
  const account: SessionAccount | null = await resolveSession(token);
  if (!account) {
    reply.header("Set-Cookie", clearSessionCookie());
    fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    return null;
  }
  request.account = account;
  return account;
}

/**
 * The signed-in account when there is a valid session, otherwise null —
 * never replies. For routes anonymous visitors may also use (shared links).
 */
export async function optionalSession(request: FastifyRequest): Promise<SessionAccount | null> {
  const token: string | null = readSessionToken(request.headers.cookie);
  if (!token) return null;
  const account = await resolveSession(token);
  if (account) request.account = account;
  return account;
}
