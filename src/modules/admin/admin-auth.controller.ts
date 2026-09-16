import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import {
  buildAdminSessionCookie,
  clearAdminSessionCookie,
  readAdminSessionToken,
} from "../../shared/utils/admin-session-token";
import * as adminAuthService from "./admin-auth.service";
import type { AdminMeProfile } from "./admin-auth.service";

function clientIp(request: FastifyRequest): string | null {
  const forwardedFor: string | string[] | undefined = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.ip || null;
}

function mapAdmin(profile: AdminMeProfile) {
  return {
    id: profile.id,
    username: profile.username,
    email: profile.email,
    role: profile.role,
    displayName: profile.displayName,
    permissions: profile.permissions,
  };
}

export async function login(
  request: FastifyRequest<{ Body: { username?: string; password?: string } }>,
  reply: FastifyReply
) {
  try {
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!username || !password) {
      return fail(
        reply,
        AppStatus.ADMIN_AUTH_VALIDATION_FAILED,
        "username and password are required",
        400
      );
    }

    const admin = await adminAuthService.authenticateAdmin(username, password);
    if (!admin) {
      return fail(
        reply,
        AppStatus.ADMIN_AUTH_UNAUTHORIZED,
        "Invalid username or password",
        401
      );
    }

    const userAgent =
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
    const { token } = await adminAuthService.createAdminSession({
      adminUserId: admin.id,
      ip: clientIp(request),
      userAgent,
    });

    const profile = await adminAuthService.buildAdminMeProfile(admin);
    reply.header("Set-Cookie", buildAdminSessionCookie(token));
    return ok(reply, AppStatus.ADMIN_AUTH_LOGIN_OK, mapAdmin(profile));
  } catch (error: unknown) {
    logCaught("admin.admin-auth.controller.login", error);
    request.log.error(
      { err: error },
      `[admin.admin-auth.controller.login] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    return fail(reply, AppStatus.ADMIN_AUTH_LOGIN_FAILED, "Login failed", 500);
  }
}

export async function me(request: FastifyRequest, reply: FastifyReply) {
  try {
    const token = readAdminSessionToken(request.headers.cookie);
    if (!token) {
      return fail(reply, AppStatus.ADMIN_AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }
    const admin = await adminAuthService.resolveAdminSession(token);
    if (!admin) {
      reply.header("Set-Cookie", clearAdminSessionCookie());
      return fail(reply, AppStatus.ADMIN_AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }
    const profile = await adminAuthService.buildAdminMeProfile(admin);
    return ok(reply, AppStatus.ADMIN_AUTH_ME_OK, mapAdmin(profile));
  } catch (error: unknown) {
    request.log.error(
      { err: error },
      `[admin.admin-auth.controller.me] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    return fail(reply, AppStatus.ADMIN_AUTH_ME_FAILED, "Internal error", 500);
  }
}

export async function logout(request: FastifyRequest, reply: FastifyReply) {
  try {
    const token = readAdminSessionToken(request.headers.cookie);
    if (token) {
      await adminAuthService.revokeAdminSession(token);
    }
    reply.header("Set-Cookie", clearAdminSessionCookie());
    return ok(reply, AppStatus.ADMIN_AUTH_LOGOUT_OK, { ok: true });
  } catch (error: unknown) {
    logCaught("admin.admin-auth.controller.logout", error);
    request.log.error(
      { err: error },
      `[admin.admin-auth.controller.logout] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    reply.header("Set-Cookie", clearAdminSessionCookie());
    return fail(reply, AppStatus.ADMIN_AUTH_LOGOUT_FAILED, "Internal error", 500);
  }
}
