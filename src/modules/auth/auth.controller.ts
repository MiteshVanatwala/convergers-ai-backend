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
import * as plansService from "../plans/plans.service";
import { getOrgPolicyForAccount, listPendingInvitesForEmail } from "../orgs/orgs.service";
import { sendWelcomeEmail } from "../notifications/account-emails";
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

    const account = await authService.upsertGoogleAccount({
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
    if (account.isNew) sendWelcomeEmail({ email: account.email, name: account.name });

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
    return ok(reply, AppStatus.AUTH_ME_RETRIEVED, await mapMe(account));
  } catch (error: unknown) {
    request.log.error(
      { err: error },
      `[auth.controller.me] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    return fail(reply, AppStatus.AUTH_ME_FAILED, "Internal error", 500);
  }
}

const NAME_MAX_LEN = 100;

async function mapMe(account: {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  auth_provider: string;
  created_at: Date;
  impersonated_by?: string | null;
  impersonator_label?: string | null;
}) {
  const [membership, personalization, orgPolicy] = await Promise.all([
    plansService.getOrEnsureActivePlan(account.id),
    authService.getPersonalizationSettings(account.id),
    getOrgPolicyForAccount(account.id),
  ]);
  // Drives which Organization view the client shows (and whether it shows one).
  const orgStatus: "none" | "invited" | "setting_up" | "active" = orgPolicy
    ? orgPolicy.planKey
      ? "active"
      : "setting_up"
    : (await listPendingInvitesForEmail(account.email)).length > 0
      ? "invited"
      : "none";
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    pictureUrl: account.avatar_url,
    authProvider: account.auth_provider,
    createdAt: account.created_at.toISOString(),
    plan: plansService.mapAuthPlan(membership),
    defaultModelId: personalization.defaultModelId,
    filterSensitiveData: personalization.filterSensitiveData,
    org: orgPolicy
      ? {
          id: orgPolicy.orgId,
          name: orgPolicy.orgName,
          role: orgPolicy.role,
          enforceSensitiveFilter: orgPolicy.enforceSensitiveFilter,
          planKey: orgPolicy.planKey,
        }
      : null,
    orgStatus,
    impersonatedBy: account.impersonated_by
      ? { adminId: account.impersonated_by, adminLabel: account.impersonator_label ?? "an admin" }
      : null,
  };
}

export async function updateMe(
  request: FastifyRequest<{
    Body: { name?: string | null; defaultModelId?: string | null; filterSensitiveData?: boolean };
  }>,
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

    const body = request.body ?? {};
    const hasName = "name" in body;
    const hasDefaultModel = "defaultModelId" in body;
    const hasFilterSensitiveData = "filterSensitiveData" in body;
    if (!hasName && !hasDefaultModel && !hasFilterSensitiveData) {
      return fail(
        reply,
        AppStatus.AUTH_PROFILE_VALIDATION_FAILED,
        "name, defaultModelId, or filterSensitiveData is required",
        400
      );
    }

    let updatedAccount: AccountRow = account;

    if (hasName) {
      const nameRaw = body.name;
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
      updatedAccount = updated;
    }

    if (hasDefaultModel || hasFilterSensitiveData) {
      const personalizationInput: { defaultModelId?: string | null; filterSensitiveData?: boolean } = {};

      if (hasDefaultModel) {
        const raw = body.defaultModelId;
        if (raw !== null && typeof raw !== "string") {
          return fail(
            reply,
            AppStatus.AUTH_PROFILE_VALIDATION_FAILED,
            "defaultModelId must be a string or null",
            400
          );
        }
        personalizationInput.defaultModelId = raw;
      }

      if (hasFilterSensitiveData) {
        if (typeof body.filterSensitiveData !== "boolean") {
          return fail(
            reply,
            AppStatus.AUTH_PROFILE_VALIDATION_FAILED,
            "filterSensitiveData must be a boolean",
            400
          );
        }
        personalizationInput.filterSensitiveData = body.filterSensitiveData;
      }

      const result = await authService.updatePersonalizationSettings(account.id, personalizationInput);
      if (result === "invalid_model") {
        return fail(
          reply,
          AppStatus.AUTH_PROFILE_VALIDATION_FAILED,
          "Unknown or unavailable model",
          400
        );
      }
    }

    // updateProfileName() returns a plain AccountRow (no impersonation columns) when the
    // name changed — carry those fields from the original resolveSession() result, which
    // is always accurate for this request, rather than losing the impersonation banner.
    return ok(
      reply,
      AppStatus.AUTH_PROFILE_UPDATED,
      await mapMe({
        ...updatedAccount,
        impersonated_by: account.impersonated_by,
        impersonator_label: account.impersonator_label,
      })
    );
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
