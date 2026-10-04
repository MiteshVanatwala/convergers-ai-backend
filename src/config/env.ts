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
  /**
   * Transactional email. SMTP is used when SMTP_HOST is set, else Resend when
   * RESEND_API_KEY is set; with neither, email is off (callers skip sending).
   */
  email: {
    smtp: {
      host: string | undefined;
      port: number;
      /** true = TLS from the start (port 465); false = STARTTLS (port 587). */
      secure: boolean;
      user: string | undefined;
      pass: string | undefined;
    };
    resendApiKey: string | undefined;
    /** Sender, e.g. "Aikya <noreply@convergers.ai>". Falls back to SMTP_FROM. */
    from: string | undefined;
    /** Where "Contact sales" submissions are emailed. */
    salesInbox: string;
  };
  /**
   * Generated files (images, artifacts, audio). "local" writes under
   * `localDir` (development); "s3" uses an S3 bucket (production) — any
   * S3-compatible store works via `endpoint` (Cloudflare R2, MinIO…).
   */
  storage: {
    driver: "local" | "s3";
    localDir: string;
    s3: {
      bucket: string | undefined;
      region: string | undefined;
      /** Optional custom endpoint for S3-compatible stores. */
      endpoint: string | undefined;
      /** Optional key prefix inside the bucket, e.g. "prod/". */
      prefix: string;
      /** Optional static credentials; omitted = the AWS default chain (IAM role, env, profile). */
      accessKeyId: string | undefined;
      secretAccessKey: string | undefined;
    };
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
    email: {
      smtp: {
        host: process.env.SMTP_HOST?.trim() || undefined,
        port: positiveInt(process.env.SMTP_PORT, 587),
        secure: process.env.SMTP_SECURE === "true",
        user: process.env.SMTP_USER?.trim() || undefined,
        pass: process.env.SMTP_PASS || undefined,
      },
      resendApiKey: process.env.RESEND_API_KEY?.trim() || undefined,
      from: process.env.EMAIL_FROM?.trim() || process.env.SMTP_FROM?.trim() || undefined,
      salesInbox: process.env.SALES_INBOX_EMAIL?.trim() || "sales@convergers.ai",
    },
    storage: {
      driver: process.env.STORAGE_DRIVER?.trim() === "s3" ? "s3" : "local",
      localDir: process.env.STORAGE_LOCAL_DIR?.trim() || "storage",
      s3: {
        bucket: process.env.S3_BUCKET?.trim() || undefined,
        region: process.env.S3_REGION?.trim() || process.env.AWS_REGION?.trim() || undefined,
        endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
        prefix: process.env.S3_PREFIX?.trim() || "",
        accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || undefined,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || undefined,
      },
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
