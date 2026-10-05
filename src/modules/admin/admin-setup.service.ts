import type { QueryResult } from "pg";
import { getRazorpayClient } from "../billing/razorpay-client";
import { billingConfigWarnings, loadEnv } from "../../config/env";
import { getPool } from "../../infrastructure/db/pool";
import { storageLabel } from "../../infrastructure/storage/object-storage";
import { emailProviderLabel } from "../../infrastructure/email/send-email";
import { logCaught } from "../../shared/utils/log";
import { PROVIDERS, isConfigured } from "../brain/adapters/keyStore";
import { isValidGstin } from "../billing/invoices.service";
import { getEffectiveSeller } from "../billing/seller-settings.service";

/**
 * Read-only setup checklist for the admin panel: every piece of config or
 * schema the app needs, and whether it's in place. Never returns secret
 * values — only whether they're set.
 */

export type SetupStatus = "ok" | "warn" | "error";

export type SetupCheck = {
  id: string;
  label: string;
  status: SetupStatus;
  /** What's true right now, in plain language. */
  detail: string;
  /** How to fix it — only when status isn't ok. */
  fix?: string;
};

export type SetupGroup = { id: string; title: string; checks: SetupCheck[] };

/** Each migration from db/, with something it creates — presence means it was applied. */
const MIGRATION_PROBES: { file: string; purpose: string; sql: string }[] = [
  {
    file: "partitions_v2.sql",
    purpose: "Monthly partitions through 2027 + safety-net default partitions",
    sql: `SELECT to_regclass('public.credit_ledger_default') IS NOT NULL AS applied`,
  },
  {
    file: "pricing_v2.sql",
    purpose: "INR prices and once-per-payment subscription credits",
    sql: `SELECT to_regclass('public.subscription_credit_grants') IS NOT NULL AS applied`,
  },
  {
    file: "organizations_v1.sql",
    purpose: "Organizations: invites, shared pool, policies",
    sql: `SELECT to_regclass('public.org_invites') IS NOT NULL AS applied`,
  },
  {
    file: "organizations_v2.sql",
    purpose: "Organization pool top-ups",
    sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'credit_purchases' AND column_name = 'org_id') AS applied`,
  },
  {
    file: "organizations_v3.sql",
    purpose: "Organization usage + masking report, Team plan",
    sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'usage_events' AND column_name = 'redacted_count') AS applied`,
  },
  {
    file: "pricing_v3.sql",
    purpose: "Pro at 5,000 credits; subscription unit prices",
    sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'subscriptions' AND column_name = 'unit_amount_paise') AS applied`,
  },
  {
    file: "organizations_v4.sql",
    purpose: "Team plan seat changes",
    sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'subscriptions' AND column_name = 'pending_quantity') AS applied`,
  },
  {
    file: "invoices_v1.sql",
    purpose: "GST invoices and billing details",
    sql: `SELECT to_regclass('public.invoices') IS NOT NULL AS applied`,
  },
  {
    file: "seller_settings_v1.sql",
    purpose: "Seller GST details editable on the Invoicing page",
    sql: `SELECT to_regclass('public.seller_settings') IS NOT NULL AS applied`,
  },
  {
    file: "billing_profiles_v2.sql",
    purpose: "City and PIN code on billing details",
    sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'billing_profiles' AND column_name = 'postal_code') AS applied`,
  },
  {
    file: "auto_topup_v1.sql",
    purpose: "Pay-as-you-go auto top-up (saved card)",
    sql: `SELECT to_regclass('public.auto_topup_settings') IS NOT NULL AS applied`,
  },
  {
    file: "plan_features_v2.sql",
    purpose: "Pricing bullets for Team, and Pro's credit bullet",
    sql: `SELECT EXISTS (SELECT 1 FROM feature_catalog WHERE key = 'shared_credit_pool') AS applied`,
  },
  {
    file: "sales_inquiries_v1.sql",
    purpose: "Contact sales form and the Sales inquiries inbox",
    sql: `SELECT to_regclass('public.sales_inquiries') IS NOT NULL AS applied`,
  },
  {
    file: "email_login_v1.sql",
    purpose: "Sign in with an emailed one-time code",
    sql: `SELECT to_regclass('public.email_login_codes') IS NOT NULL AS applied`,
  },
  {
    file: "artifacts_v1.sql",
    purpose: "Artifacts (pages, apps, diagrams, documents) and sharing",
    sql: `SELECT to_regclass('public.artifacts') IS NOT NULL AS applied`,
  },
  {
    file: "images_v1.sql",
    purpose: "Gemini image models ahead of gpt-image-1",
    sql: `SELECT EXISTS (SELECT 1 FROM provider_registry WHERE id = 'gemini:gemini-3.1-flash-image') AS applied`,
  },
  {
    file: "voice_v1.sql",
    purpose: "Voice input and read-aloud models",
    sql: `SELECT EXISTS (SELECT 1 FROM provider_registry WHERE id = 'groq:whisper-large-v3-turbo') AS applied`,
  },
  {
    file: "test_mode_v1.sql",
    purpose: "Test mode (cheapest models) for chosen accounts",
    sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'test_mode') AS applied`,
  },
];

const PARTITIONED_TABLES = ["credit_ledger", "usage_events", "messages"];

/** Read-only call to confirm Razorpay accepts the keys (a regenerated key pair is rejected with 401). */
async function verifyRazorpayKeys(): Promise<"ok" | "rejected" | "unreachable"> {
  try {
    await getRazorpayClient().orders.all({ count: 1 });
    return "ok";
  } catch (error: unknown) {
    return (error as { statusCode?: unknown } | null)?.statusCode === 401 ? "rejected" : "unreachable";
  }
}

async function paymentsGroup(): Promise<SetupGroup> {
  const env = loadEnv();
  const keyId = env.razorpayKeyId ?? "";
  const mode = keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : null;
  const keysSet = Boolean(env.razorpayKeyId && env.razorpayKeySecret);
  const verified = keysSet ? await verifyRazorpayKeys() : null;
  const checks: SetupCheck[] = [
    keysSet && verified === "rejected"
      ? {
          id: "razorpay_keys",
          label: "Razorpay keys",
          status: "error",
          detail: "Set, but Razorpay rejects them (Authentication failed) — every checkout fails.",
          fix: "Generate a new key pair in Razorpay → Account & Settings → API Keys, put both in backend/.env and restart the backend.",
        }
      : keysSet && verified === "unreachable"
        ? {
            id: "razorpay_keys",
            label: "Razorpay keys",
            status: "warn",
            detail: "Set, but Razorpay couldn't be reached to check them.",
            fix: "Check the server's internet access, then Re-check.",
          }
      : keysSet
      ? {
          id: "razorpay_keys",
          label: "Razorpay keys",
          status: mode === "test" ? "warn" : "ok",
          detail: mode === "test" ? "Set — test mode (no real money is collected)." : "Set — live mode.",
          ...(mode === "test" ? { fix: "Switch to rzp_live_ keys in production." } : {}),
        }
      : {
          id: "razorpay_keys",
          label: "Razorpay keys",
          status: "error",
          detail: "Not set — nobody can buy credits or subscribe.",
          fix: "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env.",
        },
    env.razorpayWebhookSecret
      ? { id: "razorpay_webhook", label: "Razorpay webhook secret", status: "ok", detail: "Set." }
      : {
          id: "razorpay_webhook",
          label: "Razorpay webhook secret",
          status: "error",
          detail:
            "Not set — Pro/Team renewals won't add monthly credits, seat decreases won't apply, and " +
            "payments finished after the buyer closes the tab won't be credited.",
          fix: "Razorpay Dashboard → Webhooks: point it at POST /webhooks/razorpay, then set RAZORPAY_WEBHOOK_SECRET.",
        },
  ];
  return { id: "payments", title: "Payments", checks };
}

/**
 * SAC code is deliberately optional (not set for now): up to ₹5 crore turnover
 * it's only required on B2B invoices (4 digits). So it only warns once an
 * invoice has gone to a GST-registered buyer without one.
 */
function sacCheck(sacCode: string | undefined, b2bWithoutSac: number | null): SetupCheck {
  if (sacCode) return { id: "sac", label: "SAC code on invoices", status: "ok", detail: `Set — ${sacCode}.` };
  if (b2bWithoutSac && b2bWithoutSac > 0) {
    return {
      id: "sac",
      label: "SAC code on invoices",
      status: "warn",
      detail:
        `Not set, and ${b2bWithoutSac} invoice${b2bWithoutSac === 1 ? " has" : "s have"} gone to GST-registered ` +
        "buyers — B2B invoices need at least a 4-digit SAC code.",
      fix: "Ask your CA for the right SAC code and add it on the Invoicing page.",
    };
  }
  return {
    id: "sac",
    label: "SAC code on invoices",
    status: "ok",
    detail:
      "Not set (optional for now). Becomes required on B2B invoices, or on all invoices above ₹5 crore turnover — " +
      "this will warn if an invoice goes to a GST-registered buyer.",
  };
}

async function invoicingChecks(
  pendingInvoices: number | null,
  b2bWithoutSac: number | null
): Promise<SetupCheck[]> {
  const seller = await getEffectiveSeller();
  const configured = Boolean(seller.legalName && seller.gstin && isValidGstin(seller.gstin));
  const checks: SetupCheck[] = [
    configured
      ? {
          id: "seller",
          label: "Seller GST details",
          status: seller.address ? "ok" : "warn",
          detail: seller.address
            ? `Set — ${seller.legalName}, GSTIN ${seller.gstin}.`
            : `Set — ${seller.legalName}, GSTIN ${seller.gstin}, but no address.`,
          ...(seller.address ? {} : { fix: "Add the address on the Invoicing page — a tax invoice needs the supplier's address." }),
        }
      : {
          id: "seller",
          label: "Seller GST details",
          status: "error",
          detail:
            seller.gstin && !isValidGstin(seller.gstin)
              ? `SELLER_GSTIN "${seller.gstin}" isn't a valid 15-character GSTIN — no invoices are issued.`
              : "Not set — payments don't get GST invoices.",
          fix: "Add your legal name, GSTIN and address on the Invoicing page.",
        },
    sacCheck(seller.sacCode, b2bWithoutSac),
  ];
  if (pendingInvoices !== null) {
    checks.push(
      pendingInvoices === 0
        ? { id: "pending_invoices", label: "Payments without an invoice", status: "ok", detail: "None." }
        : {
            id: "pending_invoices",
            label: "Payments without an invoice",
            status: configured ? "warn" : "error",
            detail: `${pendingInvoices} payment${pendingInvoices === 1 ? " still needs" : "s still need"} a GST invoice.`,
            fix: configured
              ? "Run: npx tsx scripts/backfill-invoices.ts --apply"
              : "Add the seller details on the Invoicing page first, then run: npx tsx scripts/backfill-invoices.ts --apply",
          }
    );
  }
  return checks;
}

async function databaseGroup(): Promise<{ group: SetupGroup; invoicesTableExists: boolean }> {
  const pool = getPool();
  const checks: SetupCheck[] = [];
  let invoicesTableExists = false;

  for (const probe of MIGRATION_PROBES) {
    const result: QueryResult<{ applied: boolean }> = await pool.query(probe.sql);
    const applied = result.rows[0]?.applied === true;
    if (probe.file === "invoices_v1.sql") invoicesTableExists = applied;
    checks.push(
      applied
        ? { id: `migration_${probe.file}`, label: probe.file, status: "ok", detail: probe.purpose }
        : {
            id: `migration_${probe.file}`,
            label: probe.file,
            status: "error",
            detail: `Not applied — ${probe.purpose.toLowerCase()} won't work.`,
            fix: `psql "$DATABASE_URL" -f backend/db/${probe.file}`,
          }
    );
  }

  // Partitions: an insert with no matching month fails outright, so stay ahead.
  const parts: QueryResult<{ parent: string; last_month: string | null; has_default: boolean }> = await pool.query(
    `SELECT parent.relname AS parent,
            max(substring(child.relname from '(\\d{4}_\\d{2})$')) AS last_month,
            bool_or(child.relname LIKE '%\\_default') AS has_default
     FROM pg_inherits i
     JOIN pg_class parent ON parent.oid = i.inhparent
     JOIN pg_class child ON child.oid = i.inhrelid
     WHERE parent.relname = ANY($1::text[])
     GROUP BY parent.relname`,
    [PARTITIONED_TABLES]
  );
  const now = new Date();
  for (const table of PARTITIONED_TABLES) {
    const row = parts.rows.find((r) => r.parent === table);
    const [y, m] = (row?.last_month ?? "").split("_").map(Number);
    const monthsAhead = y && m ? (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth()) : -1;
    const lastLabel = y && m ? `${new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" })} ${y}` : "none";
    let status: SetupStatus = "ok";
    let detail = `Monthly partitions through ${lastLabel}${row?.has_default ? ", plus a safety-net default" : ""}.`;
    if (monthsAhead < 0) {
      status = row?.has_default ? "warn" : "error";
      detail = row?.has_default
        ? `No partition for this month — rows are landing in the default partition.`
        : `No partition for this month — every insert into ${table} fails.`;
    } else if (monthsAhead < 2) {
      status = "warn";
      detail = `Partitions run out after ${lastLabel}.`;
    }
    checks.push({
      id: `partitions_${table}`,
      label: `${table} partitions`,
      status,
      detail,
      ...(status === "ok" ? {} : { fix: "Raise end_month in backend/db/partitions_v2.sql and re-run it." }),
    });
  }

  return { group: { id: "database", title: "Database", checks }, invoicesTableExists };
}

async function providersGroup(): Promise<SetupGroup> {
  const pool = getPool();
  // Credentials actually used by an enabled routing rule.
  const used: QueryResult<{ key_provider_id: string }> = await pool.query(
    `SELECT DISTINCT pr.key_provider_id
     FROM provider_routing_rules rr JOIN provider_registry pr ON pr.id = rr.provider_id
     WHERE rr.enabled AND pr.status = 'active' AND pr.key_provider_id IS NOT NULL`
  );
  const usedIds = new Set(used.rows.map((r) => r.key_provider_id));
  // Recent failures per credential — e.g. a key that's set but rejected.
  const failures: QueryResult<{ key_provider_id: string; errors: string; total: string }> = await pool.query(
    `SELECT pr.key_provider_id,
            COUNT(*) FILTER (WHERE ue.outcome = 'error')::text AS errors,
            COUNT(*)::text AS total
     FROM usage_events ue JOIN provider_registry pr ON pr.id = ue.provider
     WHERE ue.created_at > now() - interval '24 hours'
     GROUP BY pr.key_provider_id`
  );

  const checks: SetupCheck[] = PROVIDERS.filter((p) => usedIds.has(p.id)).map((p) => {
    const f = failures.rows.find((r) => r.key_provider_id === p.id);
    const errors = Number(f?.errors ?? 0);
    const total = Number(f?.total ?? 0);
    if (!isConfigured(p.id)) {
      return {
        id: `provider_${p.id}`,
        label: p.label,
        status: "error" as const,
        detail: "No key — its models are skipped (requests fall back to other models).",
        fix: `Add a key on the Providers page, or set ${p.envVar}.`,
      };
    }
    if (total > 0 && errors / total >= 0.5) {
      return {
        id: `provider_${p.id}`,
        label: p.label,
        status: "warn" as const,
        detail: `Key set, but ${errors} of ${total} requests failed in the last 24 hours.`,
        fix: "Check the key and the provider account (billing, access, rate limits).",
      };
    }
    return {
      id: `provider_${p.id}`,
      label: p.label,
      status: "ok" as const,
      detail: total > 0 ? `Key set · ${total - errors} of ${total} requests OK in the last 24 hours.` : "Key set.",
    };
  });
  return { id: "providers", title: "AI providers (used by routing)", checks };
}

function signInGroup(): SetupGroup {
  const env = loadEnv();
  const checks: SetupCheck[] = [
    env.googleClientId && env.googleClientSecret
      ? { id: "google", label: "Google sign-in", status: "ok", detail: "Set." }
      : {
          id: "google",
          label: "Google sign-in",
          status: "error",
          detail: "Not set — users can't sign in.",
          fix: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env.",
        },
    env.cookieSecure
      ? { id: "cookies", label: "Secure cookies", status: "ok", detail: "On." }
      : {
          id: "cookies",
          label: "Secure cookies",
          status: "warn",
          detail: "Off — fine on localhost, but session cookies can travel over plain HTTP.",
          fix: "Set COOKIE_SECURE=true in production (HTTPS).",
        },
    emailProviderLabel()
      ? {
          id: "email",
          label: "Email",
          status: "ok",
          detail: `Sending via ${emailProviderLabel()} from ${env.email.from}. Welcome and plan-change emails are on; Contact sales requests go to ${env.email.salesInbox}.`,
        }
      : {
          id: "email",
          label: "Email",
          status: "warn",
          detail:
            "Not set — no welcome or plan-change emails are sent, and Contact sales requests are only saved to the Sales inquiries page.",
          fix: "Set SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM (or RESEND_API_KEY and EMAIL_FROM) in backend/.env.",
        },
  ];
  return { id: "signin", title: "Sign-in, sessions & email", checks };
}

function filesGroup(): SetupGroup {
  const env = loadEnv();
  const { storage } = env;
  const checks: SetupCheck[] = [];
  if (storage.driver === "s3") {
    const missing = [
      !storage.s3.bucket && "S3_BUCKET",
      !storage.s3.region && "S3_REGION",
    ].filter(Boolean);
    checks.push(
      missing.length === 0
        ? { id: "storage", label: "File storage", status: "ok", detail: `Generated images, artifacts and audio are stored in ${storageLabel()}.` }
        : {
            id: "storage",
            label: "File storage",
            status: "error",
            detail: "STORAGE_DRIVER is s3 but the bucket isn't fully configured — saving images and artifacts will fail.",
            fix: `Set ${missing.join(" and ")} in backend/.env (plus S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY unless the server has an IAM role).`,
          }
    );
  } else {
    checks.push(
      env.cookieSecure
        ? {
            id: "storage",
            label: "File storage",
            status: "warn",
            detail: `Files are on ${storageLabel()} — they're lost if the server is replaced and aren't shared between servers.`,
            fix: "Set STORAGE_DRIVER=s3 with S3_BUCKET and S3_REGION in backend/.env for production.",
          }
        : { id: "storage", label: "File storage", status: "ok", detail: `Files are on ${storageLabel()} (fine for development).` }
    );
  }
  const gemini = isConfigured("gemini");
  const groq = isConfigured("groq");
  const imageModels = [
    gemini && "Gemini",
    isConfigured("anthropic") && "Claude (code-drawn images and GIFs)",
    isConfigured("openai") && "gpt-image-1",
  ].filter(Boolean);
  checks.push(
    imageModels.length > 0
      ? { id: "images", label: "Image generation", status: "ok", detail: `In order of the Image routing tab: ${imageModels.join(", ")}.` }
      : {
          id: "images",
          label: "Image generation",
          status: "warn",
          detail: "No Gemini, Anthropic or OpenAI key — image requests will fail.",
          fix: "Add a Google Gemini key on the API Keys page.",
        },
    groq
      ? { id: "voice_in", label: "Voice input", status: "ok", detail: "Groq Whisper." }
      : {
          id: "voice_in",
          label: "Voice input",
          status: "warn",
          detail: "No Groq key — the mic button can't transcribe.",
          fix: "Add a Groq key on the API Keys page.",
        },
    gemini || groq
      ? {
          id: "voice_out",
          label: "Read aloud",
          status: "ok",
          detail: "Gemini TTS, then Groq Orpheus (English). The browser's own voice is used if neither answers.",
        }
      : {
          id: "voice_out",
          label: "Read aloud",
          status: "warn",
          detail: "No Gemini or Groq key — answers are read with the browser's built-in voice.",
          fix: "Add a Google Gemini key on the API Keys page.",
        }
  );
  return { id: "files", title: "Files, images & voice", checks };
}

async function countPendingInvoices(): Promise<number> {
  const result: QueryResult<{ n: string }> = await getPool().query(
    `SELECT (
       (SELECT COUNT(*) FROM credit_purchases p WHERE p.status = 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.source_type = 'credit_purchase' AND i.source_id = p.id::text))
     + (SELECT COUNT(*) FROM subscription_credit_grants g
          WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.source_type = 'subscription_payment' AND i.source_id = g.razorpay_payment_id))
     )::text AS n`
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Invoices issued to GST-registered buyers (B2B) without a SAC code. */
async function countB2bInvoicesWithoutSac(): Promise<number> {
  const result: QueryResult<{ n: string }> = await getPool().query(
    `SELECT COUNT(*)::text AS n FROM invoices WHERE sac_code IS NULL AND buyer->>'gstin' IS NOT NULL`
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function getSetupChecklist(): Promise<{ groups: SetupGroup[]; warnings: string[] }> {
  try {
    const { group: database, invoicesTableExists } = await databaseGroup();
    const pending = invoicesTableExists ? await countPendingInvoices() : null;
    const b2bWithoutSac = invoicesTableExists ? await countB2bInvoicesWithoutSac() : null;
    const payments = await paymentsGroup();
    payments.checks.push(...(await invoicingChecks(pending, b2bWithoutSac)));
    const groups = [payments, database, await providersGroup(), filesGroup(), signInGroup()];
    return { groups, warnings: billingConfigWarnings() };
  } catch (error: unknown) {
    logCaught("admin.setup.service.getSetupChecklist", error);
    throw error;
  }
}
