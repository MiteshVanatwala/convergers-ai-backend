import { createHash, randomBytes } from "crypto";
import { loadEnv } from "../../config/env";
import { cookieShouldBeSecure } from "./session-token";

export function hashAdminToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newAdminSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function adminSessionCookieName(): string {
  return loadEnv().adminSessionCookieName;
}

export function buildAdminSessionCookie(token: string): string {
  const env = loadEnv();
  const maxAge = env.adminSessionTtlDays * 86400;
  const parts = [
    `${env.adminSessionCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${env.cookieSameSite}`,
    `Max-Age=${maxAge}`,
  ];
  if (cookieShouldBeSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function clearAdminSessionCookie(): string {
  const env = loadEnv();
  const parts = [
    `${env.adminSessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${env.cookieSameSite}`,
    "Max-Age=0",
  ];
  if (cookieShouldBeSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function readAdminSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const name = adminSessionCookieName();
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}
