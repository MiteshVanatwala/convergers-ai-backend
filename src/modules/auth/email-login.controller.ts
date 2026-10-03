import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { isEmailConfigured } from "../../infrastructure/email/send-email";
import { consumeRateLimit } from "../../infrastructure/http/rate-limit";
import { fail, ok } from "../../shared/http/api-response";
import { buildSessionCookie, newSessionToken } from "../../shared/utils/session-token";
import { logCaught } from "../../shared/utils/log";
import { sendLoginCodeEmail, sendWelcomeEmail } from "../notifications/account-emails";
import * as authService from "./auth.service";
import * as emailLoginService from "./email-login.service";
import { LOGIN_CODE_TTL_MINUTES } from "./email-login.service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

// Per email (DB-backed, survives restarts).
const RESEND_COOLDOWN_SEC = 30;
const MAX_SENDS_PER_HOUR = 5;
// Per IP (in-process) — stops one client spraying many addresses or guesses.
const IP_SENDS_PER_HOUR = 20;
const IP_VERIFIES_PER_10_MIN = 30;

function clientIp(request: FastifyRequest): string | null {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0]!.trim();
  }
  return request.ip || null;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function hashCode(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function codeMatches(code: string) {
  return (salt: string, hash: string): boolean => {
    const actual = Buffer.from(hashCode(salt, code), "hex");
    const expected = Buffer.from(hash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

function tooMany(reply: FastifyReply, message: string, retryAfterSec: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
  return fail(reply, AppStatus.AUTH_EMAIL_RATE_LIMITED, message, 429);
}

/**
 * POST /auth/email/start { email } — emails a 6-digit sign-in code.
 * Answers the same whether or not an account exists, so it can't be used to
 * discover who has signed up.
 */
export async function startEmailLogin(
  request: FastifyRequest<{ Body: { email?: string } }>,
  reply: FastifyReply
) {
  try {
    const email = normalizeEmail(request.body?.email);
    if (!email) {
      return fail(reply, AppStatus.AUTH_EMAIL_VALIDATION_FAILED, "Enter a valid email address.", 400);
    }
    if (!isEmailConfigured()) {
      return fail(
        reply,
        AppStatus.AUTH_EMAIL_UNAVAILABLE,
        "Email sign-in isn't available right now. Please continue with Google.",
        503
      );
    }

    const ip = clientIp(request);
    const ipLimit = consumeRateLimit(`email-login-send:${ip ?? "unknown"}`, IP_SENDS_PER_HOUR, 60 * 60 * 1000);
    if (!ipLimit.allowed) {
      return tooMany(reply, "Too many sign-in attempts. Try again later.", ipLimit.retryAfterSec);
    }

    const recent = await emailLoginService.getRecentCodeSends(email);
    if (recent.lastSentAt) {
      const waitSec = RESEND_COOLDOWN_SEC - (Date.now() - recent.lastSentAt.getTime()) / 1000;
      if (waitSec > 0) {
        return tooMany(reply, `Please wait ${Math.ceil(waitSec)} seconds before requesting a new code.`, waitSec);
      }
    }
    if (recent.sentLastHour >= MAX_SENDS_PER_HOUR) {
      return tooMany(reply, "Too many codes requested for this email. Try again in an hour.", 60 * 60);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    await emailLoginService.createLoginCode({ email, salt, hash: hashCode(salt, code), ip });
    await sendLoginCodeEmail(email, code, LOGIN_CODE_TTL_MINUTES);

    return ok(reply, AppStatus.AUTH_EMAIL_CODE_SENT, {
      email,
      expiresInSeconds: LOGIN_CODE_TTL_MINUTES * 60,
      resendAfterSeconds: RESEND_COOLDOWN_SEC,
    });
  } catch (error: unknown) {
    logCaught("auth.email-login.controller.startEmailLogin", error);
    request.log.error({ err: error }, "[auth.email-login.controller.startEmailLogin] failed");
    return fail(reply, AppStatus.AUTH_EMAIL_FAILED, "Couldn't send the code. Please try again.", 500);
  }
}

/** POST /auth/email/verify { email, code } — checks the code, signs in (creating the account on first use). */
export async function verifyEmailLogin(
  request: FastifyRequest<{ Body: { email?: string; code?: string } }>,
  reply: FastifyReply
) {
  try {
    const email = normalizeEmail(request.body?.email);
    const code = typeof request.body?.code === "string" ? request.body.code.replace(/\s/g, "") : "";
    if (!email || !CODE_RE.test(code)) {
      return fail(reply, AppStatus.AUTH_EMAIL_VALIDATION_FAILED, "Enter the 6-digit code from the email.", 400);
    }

    const ip = clientIp(request);
    const ipLimit = consumeRateLimit(`email-login-verify:${ip ?? "unknown"}`, IP_VERIFIES_PER_10_MIN, 10 * 60 * 1000);
    if (!ipLimit.allowed) {
      return tooMany(reply, "Too many attempts. Try again in a few minutes.", ipLimit.retryAfterSec);
    }

    const result = await emailLoginService.consumeLoginCode(email, codeMatches(code));
    if (result === "invalid") {
      return fail(reply, AppStatus.AUTH_EMAIL_CODE_INVALID, "That code isn't right. Check the email and try again.", 400);
    }
    if (result === "too_many_attempts") {
      return fail(reply, AppStatus.AUTH_EMAIL_CODE_EXPIRED, "Too many wrong attempts. Request a new code.", 400);
    }
    if (result === "expired") {
      return fail(reply, AppStatus.AUTH_EMAIL_CODE_EXPIRED, "This code has expired. Request a new one.", 400);
    }

    const account = await authService.upsertEmailAccount(email);
    if (account.status !== "active") {
      return fail(reply, AppStatus.AUTH_ACCOUNT_SUSPENDED, "This account is suspended. Contact support.", 403);
    }

    const token = newSessionToken();
    const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
    await authService.createSession({ accountId: account.id, token, ip, userAgent });
    await authService.recordLogin(account.id, ip, userAgent);
    if (account.isNew) sendWelcomeEmail({ email: account.email, name: account.name });

    reply.header("Set-Cookie", buildSessionCookie(token));
    request.log.info({ accountId: account.id, isNew: account.isNew }, "[auth.email-login.controller.verifyEmailLogin] success");
    return ok(reply, AppStatus.AUTH_EMAIL_SIGNED_IN, { isNew: account.isNew });
  } catch (error: unknown) {
    logCaught("auth.email-login.controller.verifyEmailLogin", error);
    request.log.error({ err: error }, "[auth.email-login.controller.verifyEmailLogin] failed");
    return fail(reply, AppStatus.AUTH_EMAIL_FAILED, "Couldn't sign you in. Please try again.", 500);
  }
}
