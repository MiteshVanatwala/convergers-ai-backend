import { createHash, randomBytes } from "crypto";
import { loadEnv } from "../../config/env";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionCookieName(): string {
  return loadEnv().sessionCookieName;
}

/** Secure is required whenever SameSite=None (browsers reject None without Secure). */
export function cookieShouldBeSecure(): boolean {
  const env = loadEnv();
  return env.cookieSecure || env.cookieSameSite === "None";
}

export function buildSessionCookie(token: string): string {
  const env = loadEnv();
  const maxAge = env.sessionTtlDays * 86400;
  const parts = [
    `${env.sessionCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${env.cookieSameSite}`,
    `Max-Age=${maxAge}`,
  ];
  if (cookieShouldBeSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  const env = loadEnv();
  const parts = [
    `${env.sessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${env.cookieSameSite}`,
    "Max-Age=0",
  ];
  if (cookieShouldBeSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const name = sessionCookieName();
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}
