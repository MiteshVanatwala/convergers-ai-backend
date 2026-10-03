import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import { getEffectiveSeller } from "../billing/seller-settings.service";
import { isConfigured } from "../brain/adapters/keyStore";
import { getModelHealth, type ModelHealthStats } from "../brain/modelHealth";

/**
 * Admin dashboard snapshot — everything the live dashboard shows, from the
 * database (so it survives restarts, unlike the in-memory /admin/stats).
 * The admin app polls this every few seconds.
 */

export type DashboardRange = "1h" | "24h" | "7d";

/** Rough rate for showing provider cost (USD) next to revenue (INR); labelled as approximate in the UI. */
export const APPROX_INR_PER_USD = 88;
const TZ = "Asia/Kolkata";

const RANGES: Record<DashboardRange, { window: string; bucket: "minute" | "hour" | "day"; span: string; step: string }> = {
  "1h": { window: "1 hour", bucket: "minute", span: "59 minutes", step: "1 minute" },
  "24h": { window: "24 hours", bucket: "hour", span: "23 hours", step: "1 hour" },
  "7d": { window: "7 days", bucket: "day", span: "6 days", step: "1 day" },
};

export function isDashboardRange(value: unknown): value is DashboardRange {
  return value === "1h" || value === "24h" || value === "7d";
}

type Metric = { value: number; previous: number };

export type DashboardSnapshot = {
  generatedAt: string;
  range: DashboardRange;
  approxInrPerUsd: number;
  now: { requestsLast5m: number; activeUsersLast15m: number; errorsLast15m: number; requestsLast15m: number };
  kpis: {
    requests: Metric;
    successRate: { value: number | null; previous: number | null };
    activeUsers: Metric;
    creditsConsumed: Metric;
    providerCostUsd: Metric;
    revenuePaise: Metric;
    signups: Metric;
    redactions: Metric;
  };
  traffic: { bucket: "minute" | "hour" | "day"; points: { t: string; success: number; error: number; fallback: number }[] };
  providers: { provider: string; requests: number; errors: number; fallbacks: number; costUsd: number; credits: number }[];
  tasks: { taskType: string; requests: number }[];
  business: {
    totalUsers: number;
    newUsers7d: number;
    payingSubscriptions: number;
    mrrPaise: number;
    planMix: { plan: string; accounts: number }[];
    organizations: number;
    seats: number;
    revenueMtdPaise: number;
    providerCostMtdUsd: number;
    walletCredits: number;
    autoTopUpActive: number;
  };
  attention: { severity: "crit" | "warn" | "info"; title: string; detail: string; href?: string }[];
  models: ModelStatus[];
  feed: {
    id: string;
    kind: "request" | "signup" | "purchase" | "subscription" | "admin";
    at: string;
    title: string;
    detail: string;
    tone: "good" | "crit" | "warn" | "neutral";
  }[];
};

export type ModelStatus = {
  id: string;
  label: string;
  provider: string;
  /** operational · degraded · down · idle (no recent calls) · no_key · disabled */
  status: "operational" | "degraded" | "down" | "idle" | "no_key" | "disabled";
  reason: string;
  visibleToUsers: boolean;
  /** Task types whose automatic routing uses this model. */
  routedFor: string[];
  live: Omit<ModelHealthStats, "lastAttemptFailed">;
  /** From usage_events (answers served by this model), last 24 hours. */
  served24h: number;
  failed24h: number;
  lastServedAt: string | null;
};

const n = (v: unknown): number => Number(v ?? 0) || 0;

export async function getDashboardSnapshot(range: DashboardRange): Promise<DashboardSnapshot> {
  const cfg = RANGES[range];
  const pool = getPool();
  try {
    const [usage, now, traffic, providers, tasks, money, signups, business, planMix, feed, alerts, seller, models] =
      await Promise.all([
        // Current window vs the window before it (same length) — for KPI deltas.
        pool.query(
          `SELECT
             count(*) FILTER (WHERE cur) AS req,
             count(*) FILTER (WHERE cur AND outcome = 'success') AS ok,
             count(DISTINCT account_id) FILTER (WHERE cur) AS users,
             coalesce(sum(credits_charged) FILTER (WHERE cur), 0) AS credits,
             coalesce(sum(native_cost) FILTER (WHERE cur), 0) AS cost,
             coalesce(sum(redacted_count) FILTER (WHERE cur), 0) AS redactions,
             count(*) FILTER (WHERE NOT cur) AS p_req,
             count(*) FILTER (WHERE NOT cur AND outcome = 'success') AS p_ok,
             count(DISTINCT account_id) FILTER (WHERE NOT cur) AS p_users,
             coalesce(sum(credits_charged) FILTER (WHERE NOT cur), 0) AS p_credits,
             coalesce(sum(native_cost) FILTER (WHERE NOT cur), 0) AS p_cost,
             coalesce(sum(redacted_count) FILTER (WHERE NOT cur), 0) AS p_redactions
           FROM (
             SELECT *, created_at >= now() - $1::interval AS cur
             FROM usage_events
             WHERE created_at >= now() - 2 * $1::interval
           ) e`,
          [cfg.window]
        ),
        pool.query(
          `SELECT
             count(*) FILTER (WHERE created_at >= now() - interval '5 minutes') AS req5,
             count(*) AS req15,
             count(DISTINCT account_id) AS users15,
             count(*) FILTER (WHERE outcome <> 'success') AS err15
           FROM usage_events WHERE created_at >= now() - interval '15 minutes'`
        ),
        // Aligned buckets (IST), empty ones included so the chart has no gaps.
        pool.query(
          `WITH buckets AS (
             SELECT generate_series(
               date_trunc($1, now(), $4) - $2::interval,
               date_trunc($1, now(), $4),
               $3::interval
             ) AS t
           ), agg AS (
             SELECT date_trunc($1, created_at, $4) AS t,
                    count(*) FILTER (WHERE outcome = 'success') AS success,
                    count(*) FILTER (WHERE outcome <> 'success') AS error,
                    count(*) FILTER (WHERE fallback_used) AS fallback
             FROM usage_events
             WHERE created_at >= date_trunc($1, now(), $4) - $2::interval
             GROUP BY 1
           )
           SELECT b.t, coalesce(a.success, 0) AS success, coalesce(a.error, 0) AS error,
                  coalesce(a.fallback, 0) AS fallback
           FROM buckets b LEFT JOIN agg a ON a.t = b.t
           ORDER BY b.t`,
          [cfg.bucket, cfg.span, cfg.step, TZ]
        ),
        pool.query(
          `SELECT provider,
                  count(*) AS requests,
                  count(*) FILTER (WHERE outcome <> 'success') AS errors,
                  count(*) FILTER (WHERE fallback_used) AS fallbacks,
                  coalesce(sum(native_cost), 0) AS cost,
                  coalesce(sum(credits_charged), 0) AS credits
           FROM usage_events WHERE created_at >= now() - $1::interval
           GROUP BY provider ORDER BY requests DESC`,
          [cfg.window]
        ),
        pool.query(
          `SELECT task_type, count(*) AS requests
           FROM usage_events WHERE created_at >= now() - $1::interval
           GROUP BY task_type ORDER BY requests DESC`,
          [cfg.window]
        ),
        // Revenue = GST invoices issued (every successful payment gets one).
        pool.query(
          `SELECT
             coalesce(sum(total_paise) FILTER (WHERE issued_at >= now() - $1::interval), 0) AS cur,
             coalesce(sum(total_paise) FILTER (WHERE issued_at < now() - $1::interval), 0) AS prev,
             (SELECT coalesce(sum(total_paise), 0) FROM invoices
               WHERE issued_at >= date_trunc('month', now(), $2)) AS mtd,
             (SELECT coalesce(sum(native_cost), 0) FROM usage_events
               WHERE created_at >= date_trunc('month', now(), $2)) AS cost_mtd
           FROM invoices WHERE issued_at >= now() - 2 * $1::interval`,
          [cfg.window, TZ]
        ),
        pool.query(
          `SELECT count(*) FILTER (WHERE created_at >= now() - $1::interval) AS cur,
                  count(*) FILTER (WHERE created_at < now() - $1::interval) AS prev
           FROM accounts WHERE created_at >= now() - 2 * $1::interval`,
          [cfg.window]
        ),
        pool.query(
          `SELECT
             (SELECT count(*) FROM accounts WHERE status = 'active') AS total_users,
             (SELECT count(*) FROM accounts WHERE created_at >= now() - interval '7 days') AS new_users_7d,
             (SELECT count(*) FROM subscriptions WHERE status = 'active') AS paying,
             (SELECT coalesce(sum(coalesce(s.unit_amount_paise, p.price_inr_paise, 0) * coalesce(s.quantity, 1)), 0)
                FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active') AS mrr,
             (SELECT count(*) FROM organizations) AS orgs,
             (SELECT coalesce(sum(seats), 0) FROM organizations) AS seats,
             (SELECT coalesce(sum(balance), 0) FROM credit_wallets)
               + (SELECT coalesce(sum(balance), 0) FROM org_credit_wallets) AS wallet,
             (SELECT count(*) FROM auto_topup_settings WHERE status = 'active') AS auto_topup`
        ),
        pool.query(
          `SELECT p.display_name AS plan, count(*) AS accounts
           FROM account_plans ap JOIN plans p ON p.id = ap.plan_id
           WHERE ap.status = 'active'
           GROUP BY p.display_name ORDER BY accounts DESC`
        ),
        // Latest happenings across modules. No message content — metadata only.
        pool.query(
          `SELECT * FROM (
             (SELECT 'request' AS kind, 'u' || e.id AS id, e.created_at AS at,
                     e.task_type AS a, e.provider AS b, e.outcome AS c,
                     e.credits_charged::text AS d, a.email::text AS email, e.fallback_used AS flag
              FROM usage_events e LEFT JOIN accounts a ON a.id = e.account_id
              WHERE e.created_at >= now() - interval '7 days'
              ORDER BY e.created_at DESC LIMIT 25)
             UNION ALL
             (SELECT 'signup', 'a' || id, created_at, auth_provider, NULL, NULL, NULL, email::text, false
              FROM accounts WHERE created_at >= now() - interval '30 days'
              ORDER BY created_at DESC LIMIT 10)
             UNION ALL
             (SELECT 'purchase', 'p' || cp.id, cp.created_at, cp.status, cp.source, cp.failure_reason,
                     cp.amount_usd_cents::text, a.email::text, cp.org_id IS NOT NULL
              FROM credit_purchases cp LEFT JOIN accounts a ON a.id = cp.account_id
              WHERE cp.created_at >= now() - interval '30 days' AND cp.status <> 'pending'
              ORDER BY cp.created_at DESC LIMIT 10)
             UNION ALL
             (SELECT 'subscription', 's' || s.id, s.created_at, s.status, p.display_name, NULL,
                     s.quantity::text, a.email::text, s.org_id IS NOT NULL
              FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id LEFT JOIN accounts a ON a.id = s.account_id
              WHERE s.created_at >= now() - interval '30 days'
              ORDER BY s.created_at DESC LIMIT 10)
             UNION ALL
             (SELECT 'admin', 'l' || l.id, l.created_at, l.action, l.target_type, NULL, NULL,
                     coalesce(u.display_name, u.username::text), false
              FROM admin_audit_log l LEFT JOIN admin_users u ON u.id = l.admin_user_id
              WHERE l.created_at >= now() - interval '30 days'
              ORDER BY l.created_at DESC LIMIT 10)
           ) x ORDER BY at DESC LIMIT 30`
        ),
        pool.query(
          `SELECT
             (SELECT json_agg(t) FROM (
                SELECT provider, count(*) AS requests, count(*) FILTER (WHERE outcome <> 'success') AS errors
                FROM usage_events WHERE created_at >= now() - interval '15 minutes'
                GROUP BY provider
                HAVING count(*) >= 5 AND count(*) FILTER (WHERE outcome <> 'success') >= 0.25 * count(*)
              ) t) AS failing_providers,
             (SELECT count(*) FROM auto_topup_settings WHERE status = 'failed') AS failed_auto_topups,
             (SELECT count(*) FROM subscriptions WHERE status = 'halted') AS halted_subscriptions,
             (SELECT count(*) FROM credit_purchases
               WHERE status = 'failed' AND created_at >= now() - interval '24 hours') AS failed_payments_24h,
             (SELECT count(*) FROM credit_purchases
               WHERE status = 'pending' AND source = 'manual' AND created_at < now() - interval '1 hour'
                 AND created_at >= now() - interval '7 days') AS stuck_payments`
        ),
        getEffectiveSeller().catch(() => null),
        pool.query(
          `SELECT pr.id, pr.label, pr.status, pr.visible_to_users, pr.key_provider_id,
                  coalesce((SELECT array_agg(DISTINCT rr.task_type ORDER BY rr.task_type)
                            FROM provider_routing_rules rr
                            WHERE rr.provider_id = pr.id AND rr.enabled), '{}') AS routed_for,
                  u.served, u.failed, u.last_at
           FROM provider_registry pr
           LEFT JOIN (
             SELECT provider,
                    count(*) FILTER (WHERE outcome = 'success') AS served,
                    count(*) FILTER (WHERE outcome <> 'success') AS failed,
                    max(created_at) FILTER (WHERE outcome = 'success') AS last_at
             FROM usage_events WHERE created_at >= now() - interval '24 hours'
             GROUP BY provider
           ) u ON u.provider = pr.id
           ORDER BY pr.label`
        ),
      ]);

    const u = usage.rows[0] ?? {};
    const live = now.rows[0] ?? {};
    const m = money.rows[0] ?? {};
    const s = signups.rows[0] ?? {};
    const b = business.rows[0] ?? {};
    const al = alerts.rows[0] ?? {};

    const rate = (ok: number, total: number) => (total > 0 ? ok / total : null);

    const modelStatuses: ModelStatus[] = models.rows.map((r) => {
      const { lastAttemptFailed, ...live } = getModelHealth(r.id);
      const derived = deriveModelStatus({
        active: r.status === "active",
        keyConfigured: !r.key_provider_id || isConfigured(r.key_provider_id),
        health: { ...live, lastAttemptFailed },
      });
      return {
        id: r.id,
        label: r.label,
        provider: r.key_provider_id ?? r.id.split(":")[0],
        ...derived,
        visibleToUsers: Boolean(r.visible_to_users),
        routedFor: r.routed_for ?? [],
        live,
        served24h: n(r.served),
        failed24h: n(r.failed),
        lastServedAt: r.last_at ? new Date(r.last_at).toISOString() : null,
      };
    });

    const attention: DashboardSnapshot["attention"] = [];
    const failing = (al.failing_providers ?? []) as { provider: string; requests: number; errors: number }[];
    for (const p of failing) {
      attention.push({
        severity: "crit",
        title: `${providerName(p.provider)} is failing`,
        detail: `${p.errors} of ${p.requests} requests failed in the last 15 minutes.`,
        href: "/api-keys",
      });
    }
    const req15 = n(live.req15);
    const err15 = n(live.err15);
    if (req15 >= 10 && err15 / req15 >= 0.2 && failing.length === 0) {
      attention.push({
        severity: "crit",
        title: "High error rate",
        detail: `${Math.round((err15 / req15) * 100)}% of requests failed in the last 15 minutes.`,
      });
    }
    const down = modelStatuses.filter((m) => m.status === "down" && failing.every((f) => f.provider !== m.id));
    if (down.length > 0) {
      attention.push({
        severity: "crit",
        title: down.length === 1 ? `${down[0]!.label} is down` : `${down.length} models are down`,
        detail: down.length === 1 ? down[0]!.reason : down.map((m) => m.label).join(", "),
        href: "/api-keys",
      });
    }
    const routedNoKey = modelStatuses.filter((m) => m.status === "no_key" && m.routedFor.length > 0);
    if (routedNoKey.length > 0) {
      attention.push({
        severity: "warn",
        title: "Routed models without a key",
        detail: `${routedNoKey.map((m) => m.label).join(", ")} are skipped, so requests fall back to other models.`,
        href: "/api-keys",
      });
    }
    if (n(al.halted_subscriptions) > 0) {
      attention.push({
        severity: "warn",
        title: "Subscriptions halted",
        detail: `${n(al.halted_subscriptions)} subscription(s) stopped after repeated failed charges.`,
      });
    }
    if (n(al.failed_auto_topups) > 0) {
      attention.push({
        severity: "warn",
        title: "Auto top-up failing",
        detail: `${n(al.failed_auto_topups)} user(s) have pay-as-you-go turned off after a failed card charge.`,
      });
    }
    if (n(al.stuck_payments) > 0) {
      attention.push({
        severity: "warn",
        title: "Payments not confirmed",
        detail: `${n(al.stuck_payments)} checkout(s) still pending after an hour. Check the Razorpay webhook.`,
        href: "/setup",
      });
    }
    if (seller && !seller.gstin) {
      attention.push({
        severity: "warn",
        title: "Seller GST details missing",
        detail: "Invoices go out without your GSTIN until it's added.",
        href: "/invoicing",
      });
    }
    if (n(al.failed_payments_24h) > 0) {
      attention.push({
        severity: "info",
        title: "Failed payments",
        detail: `${n(al.failed_payments_24h)} payment(s) failed in the last 24 hours.`,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      range,
      approxInrPerUsd: APPROX_INR_PER_USD,
      now: {
        requestsLast5m: n(live.req5),
        requestsLast15m: req15,
        activeUsersLast15m: n(live.users15),
        errorsLast15m: err15,
      },
      kpis: {
        requests: { value: n(u.req), previous: n(u.p_req) },
        successRate: { value: rate(n(u.ok), n(u.req)), previous: rate(n(u.p_ok), n(u.p_req)) },
        activeUsers: { value: n(u.users), previous: n(u.p_users) },
        creditsConsumed: { value: n(u.credits), previous: n(u.p_credits) },
        providerCostUsd: { value: n(u.cost), previous: n(u.p_cost) },
        revenuePaise: { value: n(m.cur), previous: n(m.prev) },
        signups: { value: n(s.cur), previous: n(s.prev) },
        redactions: { value: n(u.redactions), previous: n(u.p_redactions) },
      },
      traffic: {
        bucket: cfg.bucket,
        points: (traffic as QueryResult<{ t: Date; success: string; error: string; fallback: string }>).rows.map(
          (r) => ({ t: r.t.toISOString(), success: n(r.success), error: n(r.error), fallback: n(r.fallback) })
        ),
      },
      providers: providers.rows.map((r) => ({
        provider: r.provider,
        requests: n(r.requests),
        errors: n(r.errors),
        fallbacks: n(r.fallbacks),
        costUsd: n(r.cost),
        credits: n(r.credits),
      })),
      tasks: tasks.rows.map((r) => ({ taskType: r.task_type, requests: n(r.requests) })),
      business: {
        totalUsers: n(b.total_users),
        newUsers7d: n(b.new_users_7d),
        payingSubscriptions: n(b.paying),
        mrrPaise: n(b.mrr),
        planMix: planMix.rows.map((r) => ({ plan: r.plan, accounts: n(r.accounts) })),
        organizations: n(b.orgs),
        seats: n(b.seats),
        revenueMtdPaise: n(m.mtd),
        providerCostMtdUsd: n(m.cost_mtd),
        walletCredits: n(b.wallet),
        autoTopUpActive: n(b.auto_topup),
      },
      attention,
      models: modelStatuses,
      feed: feed.rows.map((r) => toFeedItem(r)),
    };
  } catch (error: unknown) {
    logCaught("admin.dashboard.service.getDashboardSnapshot", error);
    throw error;
  }
}

const FAILURE_TEXT: Record<"rate_limited" | "auth" | "error", string> = {
  rate_limited: "rate limited",
  auth: "API key rejected",
  error: "request failed",
};

function deriveModelStatus(input: {
  active: boolean;
  keyConfigured: boolean;
  health: ModelHealthStats;
}): { status: ModelStatus["status"]; reason: string } {
  const h = input.health;
  if (!input.active) return { status: "disabled", reason: "Turned off in the model registry." };
  if (!input.keyConfigured) return { status: "no_key", reason: "No API key, so routing skips it." };

  const last = h.lastFailure
    ? `${FAILURE_TEXT[h.lastFailure.kind]}${h.lastFailure.status ? ` (HTTP ${h.lastFailure.status})` : ""}`
    : "";
  if (h.lastAttemptFailed && h.lastFailure?.kind === "auth") {
    return { status: "down", reason: `Last call: ${last}. Check the key and the provider account.` };
  }
  if (h.attempts15m >= 3 && h.failures15m / h.attempts15m >= 0.5) {
    return { status: "down", reason: `${h.failures15m} of ${h.attempts15m} calls failed in 15 min · last: ${last}.` };
  }
  if (h.failures15m > 0 && (h.rateLimited15m > 0 || h.failures15m / Math.max(1, h.attempts15m) >= 0.2)) {
    return {
      status: "degraded",
      reason: `${h.failures15m} of ${h.attempts15m} calls failed in 15 min · last: ${last}.`,
    };
  }
  if (h.attempts15m > 0) {
    return { status: "operational", reason: `${h.attempts15m - h.failures15m} of ${h.attempts15m} calls OK in 15 min.` };
  }
  return { status: "idle", reason: "No calls in the last 15 minutes." };
}

type FeedRow = {
  kind: DashboardSnapshot["feed"][number]["kind"];
  id: string;
  at: Date;
  a: string | null;
  b: string | null;
  c: string | null;
  d: string | null;
  email: string | null;
  flag: boolean | null;
};

function toFeedItem(r: FeedRow): DashboardSnapshot["feed"][number] {
  const base = { id: r.id, kind: r.kind, at: r.at.toISOString() };
  const who = r.email ?? "Unknown account";
  switch (r.kind) {
    case "request": {
      const ok = r.c === "success";
      return {
        ...base,
        title: `${capitalize(r.a ?? "Request")} request · ${providerName(r.b ?? "unknown")}`,
        detail: ok ? `${who} · ${n(r.d).toLocaleString("en-IN")} credits${r.flag ? " · fallback" : ""}` : `${who} · failed`,
        tone: ok ? (r.flag ? "warn" : "good") : "crit",
      };
    }
    case "signup":
      return { ...base, title: "New sign-up", detail: `${who} · ${r.a ?? ""}`, tone: "good" };
    case "purchase": {
      const ok = r.a === "succeeded";
      const amount = `₹${(n(r.d) / 100).toLocaleString("en-IN")}`;
      const what = r.b === "auto_topup" ? "Auto top-up" : r.flag ? "Shared credits" : "Credit pack";
      return {
        ...base,
        title: `${what} ${ok ? "paid" : "failed"} · ${amount}`,
        detail: ok ? who : `${who}${r.c ? ` · ${r.c}` : ""}`,
        tone: ok ? "good" : "crit",
      };
    }
    case "subscription":
      return {
        ...base,
        title: `${r.b ?? "Plan"} subscription · ${r.a ?? ""}`,
        detail: `${who}${r.flag && r.d ? ` · ${r.d} users` : ""}`,
        tone: r.a === "active" ? "good" : r.a === "halted" || r.a === "cancelled" ? "warn" : "neutral",
      };
    case "admin":
      return { ...base, title: `Admin: ${humanizeAction(r.a ?? "action")}`, detail: who, tone: "neutral" };
  }
}

/** "groq:qwen3.8-27b" → "qwen3.8-27b (groq)". */
function providerName(id: string): string {
  const i = id.indexOf(":");
  return i > 0 ? `${id.slice(i + 1)} (${id.slice(0, i)})` : id;
}

/** "provider.set_visibility" → "provider set visibility". */
function humanizeAction(action: string): string {
  return action.replace(/[._]+/g, " ").trim();
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
