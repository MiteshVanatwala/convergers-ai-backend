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
  /** Impersonation sessions are far shorter-lived than normal logins by design. */
  impersonationTtlMinutes: number;
  adminSessionCookieName: string;
  adminSessionTtlDays: number;
  cookieSecure: boolean;
  cookieSameSite: CookieSameSite;
  /** @deprecated Shared POC pool only — authenticated users use per-user wallets. */
  demoStartingCredits: number;
  /** Credits granted once on brand-new account create. Changing this does not rewrite past ledger rows. */
  signupGrantCredits: number;
  /** Max POST /admin/auth/login attempts per IP per minute. */
  adminLoginRateLimitPerMin: number;
  /** Max GET /admin/admins* reads per admin per minute. */
  adminOperatorsReadRateLimitPerMin: number;
  /** Max mutating /admin/admins* calls per admin per minute. */
  adminOperatorsMutationRateLimitPerMin: number;
  razorpayKeyId: string | undefined;
  razorpayKeySecret: string | undefined;
  razorpayWebhookSecret: string | undefined;
  /** Seller details printed on GST invoices. Invoices are only issued when legal name + GSTIN are set. */
  seller: {
    legalName: string | undefined;
    gstin: string | undefined;
    address: string | undefined;
    /** Optional SAC code for the service line — confirm with your CA. */
    sacCode: string | undefined;
    /** Invoice number prefix, e.g. "CAI" → CAI2627-000001. Keep it short: GST caps invoice numbers at 16 chars. */
    invoicePrefix: string;
  };
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
    impersonationTtlMinutes: positiveInt(process.env.IMPERSONATION_TTL_MINUTES, 30),
    adminSessionCookieName:
      process.env.ADMIN_SESSION_COOKIE_NAME?.trim() || "convergers_admin_session",
    adminSessionTtlDays: positiveInt(process.env.ADMIN_SESSION_TTL_DAYS, 7),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    cookieSameSite: parseCookieSameSite(process.env.COOKIE_SAMESITE),
    demoStartingCredits: nonNegativeInt(process.env.DEMO_STARTING_CREDITS, 100_000),
    signupGrantCredits: nonNegativeInt(process.env.SIGNUP_GRANT_CREDITS, 100),
    adminLoginRateLimitPerMin: positiveInt(process.env.ADMIN_LOGIN_RATE_LIMIT_PER_MIN, 10),
    adminOperatorsReadRateLimitPerMin: positiveInt(
      process.env.ADMIN_OPERATORS_READ_RATE_LIMIT_PER_MIN,
      120
    ),
    adminOperatorsMutationRateLimitPerMin: positiveInt(
      process.env.ADMIN_OPERATORS_MUTATION_RATE_LIMIT_PER_MIN,
      30
    ),
    razorpayKeyId: process.env.RAZORPAY_KEY_ID?.trim() || undefined,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET?.trim() || undefined,
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || undefined,
    seller: {
      legalName: process.env.SELLER_LEGAL_NAME?.trim() || undefined,
      gstin: process.env.SELLER_GSTIN?.trim().toUpperCase() || undefined,
      address: process.env.SELLER_ADDRESS?.trim() || undefined,
      sacCode: process.env.INVOICE_SAC_CODE?.trim() || undefined,
      invoicePrefix: (process.env.INVOICE_PREFIX?.trim() || "CAI").slice(0, 4).toUpperCase(),
    },
  };
}

/**
 * Env-only config gaps that silently break billing — logged once at startup.
 * (Seller GST details can also be saved in the DB, so they're checked
 * separately — see billing/seller-settings.service.ts.)
 */
export function billingConfigWarnings(env: Env = loadEnv()): string[] {
  const warnings: string[] = [];
  if (env.razorpayKeyId && !env.razorpayWebhookSecret) {
    warnings.push(
      "RAZORPAY_WEBHOOK_SECRET is not set: Razorpay webhooks will be rejected, so Pro/Team renewals won't add " +
        "monthly credits and payments completed after the buyer closes the tab won't be credited. " +
        "Set it from the Razorpay dashboard's webhook page."
    );
  }
  return warnings;
}

export function primaryWebOrigin(env: Env = loadEnv()): string {
  return env.webOrigins[0] ?? "http://localhost:3000";
}

export function primaryAdminOrigin(env: Env = loadEnv()): string {
  return env.adminOrigins[0] ?? "http://localhost:3002";
}
