import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { primaryWebOrigin } from "../../config/env";
import { fail, ok } from "../../shared/http/api-response";
import {
  buildSessionCookie,
  clearSessionCookie,
  newOAuthState,
  newSessionToken,
  readSessionToken,
} from "../../shared/utils/session-token";
import { logCaught } from "../../shared/utils/log";
import * as authService from "./auth.service";
import type { AccountRow, SessionAccount } from "./types";
import type { GoogleOAuthConfig } from "./google.oauth";
import {
  buildGoogleAuthorizeUrl,
  exchangeCodeForAccessToken,
  fetchGoogleUserInfo,
  requireGoogleConfig,
} from "./google.oauth";

function clientIp(request: FastifyRequest): string | null {
  const forwardedFor: string | string[] | undefined = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.ip || null;
}

function loginRedirect(webOrigin: string, params: Record<string, string>): string {
  const loginUrl: URL = new URL("/login", webOrigin);
  for (const [key, value] of Object.entries(params)) {
    loginUrl.searchParams.set(key, value);
  }
  return loginUrl.toString();
}

export async function startGoogle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const config: GoogleOAuthConfig = requireGoogleConfig();
    const state: string = newOAuthState();
    await authService.insertOAuthState(state, "web");
    request.log.info("[auth.controller.startGoogle] redirecting to Google");
    await reply.redirect(buildGoogleAuthorizeUrl(config.clientId, config.redirectUri, state));
  } catch (error: unknown) {
    request.log.error(
      { err: error },
      `[auth.controller.startGoogle] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    await reply.redirect(loginRedirect(primaryWebOrigin(), { error: "config" }));
  }
}

export async function googleCallback(
  request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const config: GoogleOAuthConfig = requireGoogleConfig();
    const code: string | undefined = request.query.code;
    const state: string | undefined = request.query.state;
    const oauthError: string | undefined = request.query.error;

    if (oauthError === "access_denied") {
      await reply.redirect(loginRedirect(config.webOrigin, { error: "access_denied" }));
      return;
    }
    if (!code || !state) {
      await reply.redirect(loginRedirect(config.webOrigin, { error: "state" }));
      return;
    }

    const stateAccepted: boolean = await authService.consumeOAuthState(state, "web");
    if (!stateAccepted) {
      request.log.warn("[auth.controller.googleCallback] bad or expired state");
      await reply.redirect(loginRedirect(config.webOrigin, { error: "state" }));
      return;
    }

    const exchanged = await exchangeCodeForAccessToken(code, config);
    if ("error" in exchanged) {
      request.log.error(
        { error: exchanged.error },
        "[auth.controller.googleCallback] token exchange failed"
      );
      await reply.redirect(loginRedirect(config.webOrigin, { error: "exchange" }));
      return;
    }

    const profile = await fetchGoogleUserInfo(exchanged.accessToken);
    if (!profile?.sub || !profile.email) {
      request.log.error("[auth.controller.googleCallback] profile fetch failed");
      await reply.redirect(loginRedirect(config.webOrigin, { error: "exchange" }));
      return;
    }

    const account: AccountRow = await authService.upsertGoogleAccount({
      googleId: profile.sub,
      email: profile.email,
      emailVerified: Boolean(profile.email_verified),
      name: profile.name ?? null,
      pictureUrl: profile.picture ?? null,
    });

    if (account.status !== "active") {
      await reply.redirect(loginRedirect(config.webOrigin, { error: "suspended" }));
      return;
    }

    const rawToken: string = newSessionToken();
    const ipAddress: string | null = clientIp(request);
    const userAgent: string | null =
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
    await authService.createSession({
      accountId: account.id,
      token: rawToken,
      ip: ipAddress,
      userAgent,
    });
    await authService.recordLogin(account.id, ipAddress, userAgent);

    reply.header("Set-Cookie", buildSessionCookie(rawToken));
    request.log.info({ accountId: account.id }, "[auth.controller.googleCallback] success");
    await reply.redirect(`${config.webOrigin}/?auth=ok`);
  } catch (error: unknown) {
    request.log.error(
      { err: error },
      `[auth.controller.googleCallback] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    await reply.redirect(loginRedirect(primaryWebOrigin(), { error: "unknown" }));
  }
}

export async function me(request: FastifyRequest, reply: FastifyReply) {
  try {
    const token: string | null = readSessionToken(request.headers.cookie);
    if (!token) {
      return fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }
    const account: SessionAccount | null = await authService.resolveSession(token);
    if (!account) {
      reply.header("Set-Cookie", clearSessionCookie());
      return fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }
    return ok(reply, AppStatus.AUTH_ME_RETRIEVED, mapMe(account));
  } catch (error: unknown) {
    request.log.error(
      { err: error },
      `[auth.controller.me] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    return fail(reply, AppStatus.AUTH_ME_FAILED, "Internal error", 500);
  }
}

const NAME_MAX_LEN = 100;

function mapMe(account: {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: string;
  created_at: Date;
}) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    pictureUrl: account.avatar_url,
    authProvider: account.auth_provider,
    createdAt: account.created_at.toISOString(),
  };
}

export async function updateMe(
  request: FastifyRequest<{ Body: { name?: string | null } }>,
  reply: FastifyReply
) {
  try {
    const token: string | null = readSessionToken(request.headers.cookie);
    if (!token) {
      return fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }
    const account: SessionAccount | null = await authService.resolveSession(token);
    if (!account) {
      reply.header("Set-Cookie", clearSessionCookie());
      return fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }

    if (!("name" in (request.body ?? {}))) {
      return fail(reply, AppStatus.AUTH_PROFILE_VALIDATION_FAILED, "name is required", 400);
    }

    const nameRaw = request.body?.name;
    let name: string | null;
    if (nameRaw === null) {
      name = null;
    } else if (typeof nameRaw === "string") {
      const trimmed = nameRaw.trim();
      if (trimmed.length > NAME_MAX_LEN) {
        return fail(
          reply,
          AppStatus.AUTH_PROFILE_VALIDATION_FAILED,
          `name must be at most ${NAME_MAX_LEN} characters`,
          400
        );
      }
      name = trimmed.length > 0 ? trimmed : null;
    } else {
      return fail(reply, AppStatus.AUTH_PROFILE_VALIDATION_FAILED, "name must be a string or null", 400);
    }

    const updated = await authService.updateProfileName(account.id, name);
    if (!updated) {
      return fail(reply, AppStatus.AUTH_UNAUTHORIZED, "Unauthorized", 401);
    }

    return ok(reply, AppStatus.AUTH_PROFILE_UPDATED, mapMe(updated));
  } catch (error: unknown) {
    logCaught("auth.controller.updateMe", error);
    request.log.error(
      { err: error },
      `[auth.controller.updateMe] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    return fail(reply, AppStatus.AUTH_PROFILE_UPDATE_FAILED, "Failed to update profile", 500);
  }
}

export async function logout(request: FastifyRequest, reply: FastifyReply) {
  try {
    const token: string | null = readSessionToken(request.headers.cookie);
    if (token) {
      await authService.revokeSession(token);
    }
    reply.header("Set-Cookie", clearSessionCookie());
    request.log.info("[auth.controller.logout] ok");
    return ok(reply, AppStatus.AUTH_LOGOUT_OK, { ok: true });
  } catch (error: unknown) {
    logCaught("auth.controller.logout", error);
    request.log.error(
      { err: error },
      `[auth.controller.logout] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    reply.header("Set-Cookie", clearSessionCookie());
    return fail(reply, AppStatus.AUTH_LOGOUT_FAILED, "Internal error", 500);
  }
}
