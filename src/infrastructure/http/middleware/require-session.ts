import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../../config/app-status-codes";
import { fail } from "../../../shared/http/api-response";
import { clearSessionCookie, readSessionToken } from "../../../shared/utils/session-token";
import { resolveSession } from "../../../modules/auth/auth.service";
import type { SessionAccount } from "../../../modules/auth/types";
export function extractSessionToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) {
      return token;
    }
  }
  return readSessionToken(request.headers.cookie);
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionAccount | null> {
  const token: string | null = extractSessionToken(request);
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
