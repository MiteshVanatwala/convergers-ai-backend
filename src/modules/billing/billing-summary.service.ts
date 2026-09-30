import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import { getBalance } from "../ledger/ledger.service";
import { getSpendable } from "../ledger/spend.service";

const PURCHASE_HISTORY_LIMIT = 20;

export type BillingSummary = {
  plan: {
    key: string;
    displayName: string;
    priceUsdCents: number | null;
    priceInrPaise: number | null;
    includedCredits: number | null;
    rateLimitRpm: number | null;
    /** Free credits topped up automatically every `recurringGrantPeriodHours` (0 = none). */
    recurringGrantCredits: number;
    recurringGrantPeriodHours: number | null;
    startedAt: string;
  } | null;
  balance: number;
  /** Set when the account is in an organization — its requests spend the shared pool, not `balance`. */
  org: {
    name: string;
    role: string;
    poolBalance: number;
    /** What this member can spend right now (pool, capped by their monthly limit). */
    available: number;
    monthlyLimit: number | null;
    spentThisMonth: number;
  } | null;
  /** When the next recurring grant is due, if the plan has one. */
  nextGrantAt: string | null;
  /** Most recent Razorpay subscription (Pro), excluding never-completed checkouts. */
  subscription: {
    planName: string;
    status: string;
    currentPeriodEnd: string | null;
    createdAt: string;
  } | null;
  /** Completed or failed credit top-ups, newest first. Abandoned checkouts are omitted. */
  purchases: {
    id: string;
    credits: number;
    amountInrPaise: number;
    status: string;
    paymentId: string | null;
    createdAt: string;
  }[];
};

type PlanRow = {
  key: string;
  display_name: string;
  price_usd_cents: number | null;
  price_inr_paise: number | null;
  included_credits: number | null;
  rate_limit_rpm: number | null;
  recurring_grant_credits: number;
  recurring_grant_period_hours: number | null;
  started_at: Date;
  last_recurring_grant_at: Date | null;
};

export async function getBillingSummary(accountId: string): Promise<BillingSummary> {
  try {
    const pool = getPool();
    // getBalance first: it applies any due recurring grant, which moves
    // last_recurring_grant_at — read the plan row after so nextGrantAt is current.
    const [balance, spendable] = await Promise.all([getBalance(accountId), getSpendable(accountId)]);

    const [planResult, subscriptionResult, purchasesResult]: [
      QueryResult<PlanRow>,
      QueryResult<{ plan_name: string; status: string; current_period_end: Date | null; created_at: Date }>,
      QueryResult<{
        id: string;
        credits: string;
        amount_inr_paise: number;
        status: string;
        razorpay_payment_id: string | null;
        created_at: Date;
      }>,
    ] = await Promise.all([
      pool.query(
        `SELECT p.key, p.display_name, p.price_usd_cents, p.price_inr_paise, p.included_credits, p.rate_limit_rpm,
                p.recurring_grant_credits, p.recurring_grant_period_hours,
                ap.started_at, w.last_recurring_grant_at
         FROM account_plans ap
         JOIN plans p ON p.id = ap.plan_id
         LEFT JOIN credit_wallets w ON w.account_id = ap.account_id
         WHERE ap.account_id = $1 AND ap.status = 'active'
         LIMIT 1`,
        [accountId]
      ),
      pool.query(
        `SELECT p.display_name AS plan_name, s.status, s.current_period_end, s.created_at
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.account_id = $1 AND s.status <> 'pending'
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [accountId]
      ),
      // amount_usd_cents is a legacy (Stripe-era) name — Razorpay purchases store INR paise in it.
      pool.query(
        `SELECT id, credits, amount_usd_cents AS amount_inr_paise, status, razorpay_payment_id, created_at
         FROM credit_purchases
         WHERE account_id = $1 AND status <> 'pending'
         ORDER BY created_at DESC
         LIMIT $2`,
        [accountId, PURCHASE_HISTORY_LIMIT]
      ),
    ]);

    const plan = planResult.rows[0];
    let nextGrantAt: string | null = null;
    if (plan && plan.recurring_grant_credits > 0 && plan.recurring_grant_period_hours) {
      const last = plan.last_recurring_grant_at ?? plan.started_at;
      nextGrantAt = new Date(
        last.getTime() + plan.recurring_grant_period_hours * 60 * 60 * 1000
      ).toISOString();
    }

    const subscription = subscriptionResult.rows[0];
    return {
      plan: plan
        ? {
            key: plan.key,
            displayName: plan.display_name,
            priceUsdCents: plan.price_usd_cents,
            priceInrPaise: plan.price_inr_paise,
            includedCredits: plan.included_credits,
            rateLimitRpm: plan.rate_limit_rpm,
            recurringGrantCredits: plan.recurring_grant_credits,
            recurringGrantPeriodHours: plan.recurring_grant_period_hours,
            startedAt: plan.started_at.toISOString(),
          }
        : null,
      balance,
      org:
        spendable.context.kind === "org"
          ? {
              name: spendable.context.orgName,
              role: spendable.context.role,
              poolBalance: spendable.poolBalance ?? 0,
              available: spendable.balance,
              monthlyLimit: spendable.context.monthlyLimit,
              spentThisMonth: spendable.spentThisMonth ?? 0,
            }
          : null,
      nextGrantAt,
      subscription: subscription
        ? {
            planName: subscription.plan_name,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end?.toISOString() ?? null,
            createdAt: subscription.created_at.toISOString(),
          }
        : null,
      purchases: purchasesResult.rows.map((row) => ({
        id: row.id,
        credits: Number(row.credits),
        amountInrPaise: row.amount_inr_paise,
        status: row.status,
        paymentId: row.razorpay_payment_id,
        createdAt: row.created_at.toISOString(),
      })),
    };
  } catch (error: unknown) {
    logCaught("billing.billing-summary.service.getBillingSummary", error);
    throw error;
  }
}
