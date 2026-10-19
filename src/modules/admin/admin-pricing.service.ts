import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import { CREDIT_PACKAGES } from "../billing/credit-packages";
import { GST_RATE_BP } from "../billing/invoices.service";
import { PRICING } from "../brain/adapters/pricing";
import { allAdapters } from "../brain/router";
import {
  BYOK_FEE_CREDITS,
  CHARS_PER_TOKEN,
  MIN_AFFORDABLE_OUTPUT_TOKENS,
  PROMPT_OVERHEAD_TOKENS,
} from "../brain/router/credits";
import {
  BYOK_SEARCH_CREDITS,
  SEARCH_MODEL,
  USD_PER_PAGE,
  USD_PER_SEARCH,
} from "../brain/search/webSearch";
import { LedgerReason } from "../../config/ledger-reasons";
import { CREDITS_PER_USD, creditsForCost } from "../ledger/ledger.service";
import {
  BYOK_VOICE_CREDITS,
  GEMINI_AUDIO_TOKENS_PER_SECOND,
  ORPHEUS_USD_PER_CHAR,
  WHISPER,
  WHISPER_MIN_SECONDS,
  geminiTtsRates,
} from "../voice/voice.providers";

/**
 * Read-only explainer for the admin Pricing page: how provider usage turns
 * into credits. Every number comes from the constants the charging code uses,
 * so the page can't drift from what users are actually billed.
 */

export type PricingModel = {
  /** provider_registry id. */
  id: string;
  /** Registry label; the id when the model has no registry row. */
  label: string;
  /** Registry status ("active", …); null when the model has no registry row. */
  status: string | null;
  /** Shown to users in Models; null when the model has no registry row. */
  visibleToUsers: boolean | null;
  billing: "tokens" | "flat";
  /** Provider model id the per-token rates are keyed by (tokens billing only). */
  model: string | null;
  /** USD per million tokens; null for flat billing or when no rate is configured. */
  inputPerMTok: number | null;
  cachedInputPerMTok: number | null;
  cacheWritePerMTok: number | null;
  outputPerMTok: number | null;
  /** Rates multiply by this outside the provider's peak hours (DeepSeek). */
  offPeakMultiplier: number | null;
  /** Longest answer this model is asked for, in tokens (tokens billing only). */
  maxOutputTokens: number | null;
  /** USD per request (flat billing only, e.g. image models). */
  flatUsd: number | null;
  /** Typical USD per request when per-token rates alone mislead (e.g. Claude images). */
  typicalUsd: number | null;
};

export type AdminPricing = {
  creditsPerUsd: number;
  /** Smallest charge for any request that costs something. */
  minChargeCredits: number;
  /** Flat fees for requests served on the account's own provider key. */
  byok: { chatCredits: number; searchCredits: number; voiceCredits: number };
  /** Pre-call affordability check (router/credits.ts). */
  estimate: { charsPerToken: number; promptOverheadTokens: number; minAffordableOutputTokens: number };
  /** When DeepSeek's off-peak discount does not apply (see isDeepSeekPeak). */
  peakHours: string;
  models: PricingModel[];
  search: { model: string; usdPerSearch: number; usdPerPage: number };
  voice: {
    transcription: { id: string; model: string; usdPerHour: number }[];
    transcriptionMinSeconds: number;
    geminiInputPerMTok: number;
    geminiAudioPerMTok: number;
    geminiAudioTokensPerSecond: number;
    orpheusUsdPerMChars: number;
  };
  /** amountUsd: price for buyers outside India (no GST — export under LUT). */
  packages: { id: string; label: string; amountInr: number; amountUsd: number; credits: number }[];
  /** GST on every INR sale, in basis points; INR pack and plan prices include it. USD sales carry none. */
  gstRateBp: number;
  /** Paid plans (credits granted on each charge) and free recurring grants. */
  plans: {
    key: string;
    name: string;
    /** GST-inclusive price per charge (per seat for Team); null when free. */
    priceInr: number | null;
    /** USD price per charge for buyers outside India; null when not sold in USD. */
    priceUsd: number | null;
    /** Credits granted on each paid charge. */
    includedCredits: number;
    /** Free credits granted every `recurringGrantHours`. */
    recurringGrantCredits: number;
    recurringGrantHours: number | null;
  }[];
};

type PlanRow = {
  key: string;
  display_name: string;
  price_inr_paise: number | null;
  price_usd_cents: number | null;
  included_credits: number | null;
  recurring_grant_credits: number;
  recurring_grant_period_hours: number | null;
};

type RegistryRow = { id: string; label: string; status: string; visible_to_users: boolean };

export async function getPricing(): Promise<AdminPricing> {
  try {
    const adapters = allAdapters();
    const registry: QueryResult<RegistryRow> = await getPool().query(
      `SELECT id, label, status, visible_to_users FROM provider_registry WHERE id = ANY($1::text[])`,
      [adapters.map((a) => a.id)]
    );
    const rows = new Map(registry.rows.map((r) => [r.id, r]));
    const planRows: QueryResult<PlanRow> = await getPool().query(
      `SELECT key, display_name, price_inr_paise, price_usd_cents, included_credits, recurring_grant_credits,
              recurring_grant_period_hours
       FROM plans
       WHERE (price_inr_paise > 0 AND included_credits > 0) OR recurring_grant_credits > 0
       ORDER BY coalesce(price_inr_paise, 0), id`
    );

    const models: PricingModel[] = adapters.map((adapter) => {
      const row = rows.get(adapter.id);
      const { cost } = adapter;
      const rate = cost.kind === "tokens" ? PRICING[cost.model] : undefined;
      return {
        id: adapter.id,
        label: row?.label ?? adapter.id,
        status: row?.status ?? null,
        visibleToUsers: row?.visible_to_users ?? null,
        billing: cost.kind,
        model: cost.kind === "tokens" ? cost.model : null,
        inputPerMTok: rate?.inputPerMTok ?? null,
        cachedInputPerMTok: rate?.cachedInputPerMTok ?? null,
        cacheWritePerMTok: rate?.cacheWritePerMTok ?? null,
        outputPerMTok: rate?.outputPerMTok ?? null,
        offPeakMultiplier: rate?.offPeakMultiplier ?? null,
        maxOutputTokens: cost.kind === "tokens" ? cost.maxOutputTokens : null,
        flatUsd: cost.kind === "flat" ? cost.usd : null,
        typicalUsd: adapter.typicalUsd ?? null,
      };
    });

    const tts = geminiTtsRates();
    return {
      creditsPerUsd: CREDITS_PER_USD,
      minChargeCredits: creditsForCost(0),
      byok: { chatCredits: BYOK_FEE_CREDITS, searchCredits: BYOK_SEARCH_CREDITS, voiceCredits: BYOK_VOICE_CREDITS },
      estimate: {
        charsPerToken: CHARS_PER_TOKEN,
        promptOverheadTokens: PROMPT_OVERHEAD_TOKENS,
        minAffordableOutputTokens: MIN_AFFORDABLE_OUTPUT_TOKENS,
      },
      peakHours: "01:00–04:00 and 06:00–10:00 UTC, Monday–Friday",
      models,
      search: { model: SEARCH_MODEL, usdPerSearch: USD_PER_SEARCH, usdPerPage: USD_PER_PAGE },
      voice: {
        transcription: WHISPER.map((w) => ({ id: w.id, model: w.model, usdPerHour: w.usdPerHour })),
        transcriptionMinSeconds: WHISPER_MIN_SECONDS,
        geminiInputPerMTok: tts.inputPerToken * 1_000_000,
        geminiAudioPerMTok: tts.audioPerToken * 1_000_000,
        geminiAudioTokensPerSecond: GEMINI_AUDIO_TOKENS_PER_SECOND,
        orpheusUsdPerMChars: ORPHEUS_USD_PER_CHAR * 1_000_000,
      },
      packages: CREDIT_PACKAGES.map((p) => ({
        id: p.id,
        label: p.label,
        amountInr: p.amountInrPaise / 100,
        amountUsd: p.amountUsdCents / 100,
        credits: p.credits,
      })),
      gstRateBp: GST_RATE_BP,
      plans: planRows.rows.map((p) => ({
        key: p.key,
        name: p.display_name,
        priceInr: p.price_inr_paise ? p.price_inr_paise / 100 : null,
        priceUsd: p.price_inr_paise && p.price_usd_cents ? p.price_usd_cents / 100 : null,
        includedCredits: p.included_credits ?? 0,
        recurringGrantCredits: p.recurring_grant_credits,
        recurringGrantHours: p.recurring_grant_period_hours,
      })),
    };
  } catch (error: unknown) {
    logCaught("admin.admin-pricing.service.getPricing", error);
    throw error;
  }
}

export type ProfitRange = "7d" | "30d" | "90d" | "all";

const PROFIT_RANGES: Record<ProfitRange, string | null> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: null };

export function isProfitRange(value: unknown): value is ProfitRange {
  return typeof value === "string" && Object.hasOwn(PROFIT_RANGES, value);
}

/** Credit grants that bring in no money (ledger reasons). */
const FREE_GRANT_REASONS = [
  LedgerReason.SIGNUP_GRANT,
  LedgerReason.RECURRING_GRANT,
  LedgerReason.PROMO,
  LedgerReason.ADMIN_GRANT,
];

export type AdminProfit = {
  range: ProfitRange;
  /** Start of the period; null for all time. */
  from: string | null;
  /** By currency: INR is GST-inclusive; USD (buyers outside India) carries no GST. */
  revenue: {
    /** Successful credit-pack purchases. */
    packs: { count: number; grossInr: number; countUsd: number; grossUsd: number };
    /** Successful subscription charges (all seats). */
    subscriptions: { count: number; grossInr: number; countUsd: number; grossUsd: number };
  };
  usage: {
    /** Successful requests (chat, images, search, voice). */
    requests: number;
    /** What providers billed us, in USD. */
    providerCostUsd: number;
    /** Credits actually taken from balances. */
    creditsCharged: number;
    /** Credits the charge rule asked for but the balance couldn't cover (charge capped at the balance). */
    notRecoveredCredits: number;
  };
  /** Credits granted without payment, by ledger reason. */
  freeCredits: { reason: string; count: number; credits: number }[];
  /** Accounts with their own provider key: their requests' provider cost is in providerCostUsd but paid by them. */
  ownKeyAccounts: number;
};

type RevenueRow = {
  packs: string;
  packs_paise: string;
  packs_usd: string;
  packs_cents: string;
  subs: string;
  subs_paise: string;
  subs_usd: string;
  subs_cents: string;
};
type UsageRow = { requests: string; cost_usd: string; charged: string; not_recovered: string };
type GrantRow = { reason: string; count: string; credits: string };

/**
 * Actual money in vs provider cost for a period. Revenue is read from the
 * payment rows themselves (not invoices, which aren't issued until the seller
 * is configured, or for USD sales until the LUT is set); subscription amounts
 * follow invoices.service loadInvoiceLine.
 */
export async function getProfit(range: ProfitRange): Promise<AdminProfit> {
  try {
    const pool = getPool();
    const window = PROFIT_RANGES[range];
    const [revenue, usage, grants, ownKeys]: [
      QueryResult<RevenueRow>,
      QueryResult<UsageRow>,
      QueryResult<GrantRow>,
      QueryResult<{ accounts: string }>,
    ] = await Promise.all([
      pool.query(
        // amount_usd_cents / unit_amount_paise are legacy names: the minor unit of `currency`.
        `WITH packs AS (
           SELECT currency, amount_usd_cents AS amount FROM credit_purchases
           WHERE status = 'succeeded' AND ($1::interval IS NULL OR created_at >= now() - $1::interval)
         ), subs AS (
           SELECT s.currency,
                  coalesce(s.unit_amount_paise, CASE WHEN s.currency = 'USD' THEN p.price_usd_cents ELSE p.price_inr_paise END)
                    * CASE WHEN s.org_id IS NOT NULL THEN s.quantity ELSE 1 END AS amount
           FROM subscription_credit_grants g
           JOIN subscriptions s ON s.razorpay_subscription_id = g.razorpay_subscription_id
           JOIN plans p ON p.id = s.plan_id
           WHERE $1::interval IS NULL OR g.created_at >= now() - $1::interval
         )
         SELECT
           (SELECT count(*) FROM packs WHERE currency = 'INR') AS packs,
           (SELECT coalesce(sum(amount), 0) FROM packs WHERE currency = 'INR') AS packs_paise,
           (SELECT count(*) FROM packs WHERE currency = 'USD') AS packs_usd,
           (SELECT coalesce(sum(amount), 0) FROM packs WHERE currency = 'USD') AS packs_cents,
           (SELECT count(*) FROM subs WHERE currency = 'INR') AS subs,
           (SELECT coalesce(sum(amount), 0) FROM subs WHERE currency = 'INR') AS subs_paise,
           (SELECT count(*) FROM subs WHERE currency = 'USD') AS subs_usd,
           (SELECT coalesce(sum(amount), 0) FROM subs WHERE currency = 'USD') AS subs_cents`,
        [window]
      ),
      pool.query(
        `SELECT count(*) AS requests,
                coalesce(sum(native_cost), 0) AS cost_usd,
                coalesce(sum(credits_charged), 0) AS charged,
                -- Same rule as ledger creditsForCost: max(1, ceil(usd × CREDITS_PER_USD)).
                coalesce(sum(greatest(0, greatest(1, ceil(native_cost * $2)) - credits_charged))
                         FILTER (WHERE native_cost > 0), 0) AS not_recovered
         FROM usage_events
         WHERE outcome = 'success' AND ($1::interval IS NULL OR created_at >= now() - $1::interval)`,
        [window, CREDITS_PER_USD]
      ),
      pool.query(
        `SELECT reason, count(*) AS count, sum(amount) AS credits
         FROM credit_ledger
         WHERE amount > 0 AND reason = ANY($2::text[])
           AND ($1::interval IS NULL OR created_at >= now() - $1::interval)
         GROUP BY reason
         ORDER BY sum(amount) DESC`,
        [window, FREE_GRANT_REASONS]
      ),
      pool.query(
        `SELECT count(DISTINCT account_id) AS accounts
         FROM provider_api_keys WHERE account_id IS NOT NULL AND is_active`
      ),
    ]);

    const r = revenue.rows[0];
    const u = usage.rows[0];
    return {
      range,
      from: window === null ? null : new Date(Date.now() - parseInt(range, 10) * 86_400_000).toISOString(),
      revenue: {
        packs: {
          count: Number(r.packs),
          grossInr: Number(r.packs_paise) / 100,
          countUsd: Number(r.packs_usd),
          grossUsd: Number(r.packs_cents) / 100,
        },
        subscriptions: {
          count: Number(r.subs),
          grossInr: Number(r.subs_paise) / 100,
          countUsd: Number(r.subs_usd),
          grossUsd: Number(r.subs_cents) / 100,
        },
      },
      usage: {
        requests: Number(u.requests),
        providerCostUsd: Number(u.cost_usd),
        creditsCharged: Number(u.charged),
        notRecoveredCredits: Number(u.not_recovered),
      },
      freeCredits: grants.rows.map((g) => ({ reason: g.reason, count: Number(g.count), credits: Number(g.credits) })),
      ownKeyAccounts: Number(ownKeys.rows[0]?.accounts ?? 0),
    };
  } catch (error: unknown) {
    logCaught("admin.admin-pricing.service.getProfit", error);
    throw error;
  }
}
