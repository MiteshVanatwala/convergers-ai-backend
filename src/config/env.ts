export type CookieSameSite = "Lax" | "None" | "Strict";

export type Env = {
  port: number;
  databaseUrl: string | undefined;
  webOrigins: string[];
  adminOrigins: string[];
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  googleRedirectUri: string;
  sessionCookieName: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
  cookieSameSite: CookieSameSite;
  /** @deprecated Shared POC pool only — authenticated users use per-user wallets. */
  demoStartingCredits: number;
  /** Credits granted once on brand-new account create. Changing this does not rewrite past ledger rows. */
  signupGrantCredits: number;
};

function splitOrigins(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(",").map((o) => o.trim()).filter(Boolean);
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** Positive integer ≥ 1 (session TTL days, etc.). */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function parseCookieSameSite(raw: string | undefined): CookieSameSite {
  const normalized = (raw ?? "Lax").trim().toLowerCase();
  if (normalized === "none") return "None";
  if (normalized === "strict") return "Strict";
  return "Lax";
}

/** Read process env into a typed object. Does not throw on missing Google/DB — callers decide. */
export function loadEnv(): Env {
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    webOrigins: splitOrigins(process.env.WEB_ORIGIN, "http://localhost:3000"),
    adminOrigins: splitOrigins(process.env.ADMIN_ORIGIN, "http://localhost:3002"),
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    googleRedirectUri:
      process.env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:8787/auth/google/callback",
    sessionCookieName: process.env.SESSION_COOKIE_NAME?.trim() || "convergers_session",
    sessionTtlDays: positiveInt(process.env.SESSION_TTL_DAYS, 14),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    cookieSameSite: parseCookieSameSite(process.env.COOKIE_SAMESITE),
    demoStartingCredits: nonNegativeInt(process.env.DEMO_STARTING_CREDITS, 100_000),
    signupGrantCredits: nonNegativeInt(process.env.SIGNUP_GRANT_CREDITS, 100),
  };
}

export function primaryWebOrigin(env: Env = loadEnv()): string {
  return env.webOrigins[0] ?? "http://localhost:3000";
}
