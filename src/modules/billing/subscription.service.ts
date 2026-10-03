import type { PoolClient, QueryResult } from "pg";
import { validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils";
import { LedgerReason, LedgerReferenceType } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";
import * as plansService from "../plans/plans.service";
import { getRazorpayClient, requireRazorpayKeyId, requireRazorpayKeySecret } from "./razorpay-client";
import { issueInvoice } from "./invoices.service";
import { sendPlanChangeEmail, sendTeamPlanEmail } from "../notifications/account-emails";

export type SubscriptionErrorKind = "validation" | "not_found";

export class SubscriptionError extends Error {
  constructor(
    message: string,
    readonly kind: SubscriptionErrorKind
  ) {
    super(message);
    this.name = "SubscriptionError";
  }
}

// Razorpay subscriptions require a finite number of billing cycles — 100
// (~8 years of monthly charges) is the standard way to model "indefinite
// monthly" on their platform. Cancellation works normally regardless of how
// many cycles remain.
const SUBSCRIPTION_TOTAL_COUNT = 100;

export type CreatedSubscriptionOrder = {
  subscriptionId: string;
  keyId: string;
};

/**
 * Returns the Razorpay Plan for a plan key, creating it on first use. The
 * charge amount comes from plans.price_inr_paise; if that changed since the
 * memoized Razorpay Plan was created, a new Razorpay Plan is created (existing
 * subscriptions keep billing at their original plan's amount).
 */
async function ensureRazorpayPlanForKey(planKey: string): Promise<{ planId: string; amountPaise: number }> {
  const pool = getPool();
  const existing: QueryResult<{
    id: number | string;
    razorpay_plan_id: string | null;
    razorpay_plan_amount_paise: number | null;
    price_inr_paise: number | null;
    display_name: string;
  }> = await pool.query(
    `SELECT id, razorpay_plan_id, razorpay_plan_amount_paise, price_inr_paise, display_name
     FROM plans WHERE key = $1`,
    [planKey]
  );
  const row = existing.rows[0];
  if (!row) {
    throw new SubscriptionError(`Unknown plan "${planKey}"`, "not_found");
  }
  if (planKey !== "pro" && planKey !== "team") {
    throw new SubscriptionError(`"${planKey}" isn't set up for subscription checkout`, "validation");
  }
  if (!row.price_inr_paise || row.price_inr_paise <= 0) {
    throw new Error(`Plan "${planKey}" has no INR price — apply db/pricing_v2.sql`);
  }
  if (row.razorpay_plan_id && row.razorpay_plan_amount_paise === row.price_inr_paise) {
    return { planId: row.razorpay_plan_id, amountPaise: row.price_inr_paise };
  }

  const plan = await getRazorpayClient().plans.create({
    period: "monthly",
    interval: 1,
    item: {
      name: `${row.display_name} (monthly)`,
      amount: row.price_inr_paise,
      currency: "INR",
    },
  });

  await pool.query(
    `UPDATE plans SET razorpay_plan_id = $2, razorpay_plan_amount_paise = $3 WHERE key = $1`,
    [planKey, plan.id, row.price_inr_paise]
  );
  return { planId: plan.id, amountPaise: row.price_inr_paise };
}

/** Starts a Pro upgrade: creates the Razorpay Subscription and records it as `pending`. */
export async function createProSubscription(accountId: string): Promise<CreatedSubscriptionOrder> {
  try {
    const { planId, amountPaise } = await ensureRazorpayPlanForKey("pro");
    const proPlanRow: QueryResult<{ id: number | string }> = await getPool().query(
      `SELECT id FROM plans WHERE key = 'pro'`
    );
    const proPlanId = proPlanRow.rows[0]?.id;
    if (proPlanId == null) {
      throw new SubscriptionError("Pro plan not found in catalog", "not_found");
    }

    const subscription = await getRazorpayClient().subscriptions.create({
      plan_id: planId,
      total_count: SUBSCRIPTION_TOTAL_COUNT,
      customer_notify: 1,
      notes: { accountId },
    });

    await getPool().query(
      `INSERT INTO subscriptions (account_id, plan_id, razorpay_subscription_id, status, unit_amount_paise)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [accountId, proPlanId, subscription.id, amountPaise]
    );

    return { subscriptionId: subscription.id, keyId: requireRazorpayKeyId() };
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) throw error;
    logCaught("billing.subscription.service.createProSubscription", error);
    throw error;
  }
}

export const MAX_TEAM_SEATS = 500;

/**
 * Starts a Team plan for an organization: a Razorpay Subscription billed per
 * seat (quantity), recorded as `pending` on the org. Each successful charge
 * later adds included_credits × seats to the org pool (grantSubscriptionCredits).
 */
export async function createTeamSubscription(orgId: string, seats: number): Promise<CreatedSubscriptionOrder> {
  try {
    if (!Number.isInteger(seats) || seats < 1 || seats > MAX_TEAM_SEATS) {
      throw new SubscriptionError(`Seats must be between 1 and ${MAX_TEAM_SEATS}.`, "validation");
    }
    const pool = getPool();
    const existing = await pool.query(
      `SELECT 1 FROM subscriptions WHERE org_id = $1 AND status = 'active'`,
      [orgId]
    );
    if (existing.rows.length > 0) {
      throw new SubscriptionError("This organization already has an active Team plan.", "validation");
    }

    const { planId, amountPaise } = await ensureRazorpayPlanForKey("team");
    const teamRow: QueryResult<{ id: number | string }> = await pool.query(
      `SELECT id FROM plans WHERE key = 'team'`
    );
    const teamPlanId = teamRow.rows[0]?.id;
    if (teamPlanId == null) {
      throw new SubscriptionError("Team plan not found in catalog", "not_found");
    }

    const subscription = await getRazorpayClient().subscriptions.create({
      plan_id: planId,
      total_count: SUBSCRIPTION_TOTAL_COUNT,
      quantity: seats,
      customer_notify: 1,
      notes: { orgId },
    });

    await pool.query(
      `INSERT INTO subscriptions (org_id, plan_id, razorpay_subscription_id, status, quantity, unit_amount_paise)
       VALUES ($1, $2, $3, 'pending', $4, $5)`,
      [orgId, teamPlanId, subscription.id, seats, amountPaise]
    );

    return { subscriptionId: subscription.id, keyId: requireRazorpayKeyId() };
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) throw error;
    logCaught("billing.subscription.service.createTeamSubscription", error);
    throw error;
  }
}

/**
 * Changes the seat count of an org's active Team plan. More seats apply now
 * (Razorpay bills the change per its own proration rules); fewer seats are
 * scheduled for the end of the billing cycle — nobody loses a seat they've
 * paid for mid-month. Returns when the change takes effect.
 */
export async function changeTeamSeats(
  orgId: string,
  seats: number,
  seatsUsed: number
): Promise<{ seats: number; effective: "now" | "cycle_end" }> {
  try {
    if (!Number.isInteger(seats) || seats < 1 || seats > MAX_TEAM_SEATS) {
      throw new SubscriptionError(`Seats must be between 1 and ${MAX_TEAM_SEATS}.`, "validation");
    }
    if (seats < seatsUsed) {
      throw new SubscriptionError(
        `You have ${seatsUsed} members and pending invites — remove some before going down to ${seats} seats.`,
        "validation"
      );
    }
    const pool = getPool();
    const active: QueryResult<{ razorpay_subscription_id: string; quantity: number }> = await pool.query(
      `SELECT razorpay_subscription_id, quantity FROM subscriptions
       WHERE org_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    const sub = active.rows[0];
    if (!sub) throw new SubscriptionError("This organization has no active Team plan.", "not_found");
    if (seats === sub.quantity) {
      await pool.query(
        `UPDATE subscriptions SET pending_quantity = NULL WHERE razorpay_subscription_id = $1`,
        [sub.razorpay_subscription_id]
      );
      return { seats, effective: "now" };
    }

    const increase = seats > sub.quantity;
    await getRazorpayClient().subscriptions.update(sub.razorpay_subscription_id, {
      quantity: seats,
      schedule_change_at: increase ? "now" : "cycle_end",
    });

    if (increase) {
      await withPoolTransaction(async (client: PoolClient) => {
        await client.query(
          `UPDATE subscriptions SET quantity = $2, pending_quantity = NULL WHERE razorpay_subscription_id = $1`,
          [sub.razorpay_subscription_id, seats]
        );
        await client.query(`UPDATE organizations SET seats = $2, updated_at = now() WHERE id = $1`, [
          orgId,
          seats,
        ]);
      });
      return { seats, effective: "now" };
    }
    await pool.query(
      `UPDATE subscriptions SET pending_quantity = $2 WHERE razorpay_subscription_id = $1`,
      [sub.razorpay_subscription_id, seats]
    );
    return { seats, effective: "cycle_end" };
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) throw error;
    logCaught("billing.subscription.service.changeTeamSeats", error);
    throw error;
  }
}

/**
 * Brings a Team subscription's seat count in line with Razorpay's (sent on
 * each subscription.charged webhook) — this is where a scheduled decrease
 * lands at the start of the new cycle. Call before granting that charge's credits.
 */
export async function syncSubscriptionQuantity(input: {
  razorpaySubscriptionId: string;
  quantity: number;
}): Promise<void> {
  try {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) return;
    await withPoolTransaction(async (client: PoolClient) => {
      const updated: QueryResult<{ org_id: string | null }> = await client.query(
        `UPDATE subscriptions
         SET quantity = $2,
             pending_quantity = CASE WHEN pending_quantity = $2 THEN NULL ELSE pending_quantity END
         WHERE razorpay_subscription_id = $1 AND status = 'active'
         RETURNING org_id::text AS org_id`,
        [input.razorpaySubscriptionId, input.quantity]
      );
      const orgId = updated.rows[0]?.org_id;
      if (orgId) {
        await client.query(`UPDATE organizations SET seats = $2, updated_at = now() WHERE id = $1`, [
          orgId,
          input.quantity,
        ]);
      }
    });
  } catch (error: unknown) {
    logCaught("billing.subscription.service.syncSubscriptionQuantity", error);
    throw error;
  }
}

/**
 * Client-side fast path for subscription checkout — same
 * validatePaymentVerification helper Phase 1 uses for one-time purchases,
 * but with subscription_id in place of order_id (the SDK branches on which
 * field is present and signs payment_id|subscription_id instead of
 * order_id|payment_id — see razorpay/dist/utils/razorpay-utils.js).
 */
export function verifySubscriptionPaymentSignature(input: {
  subscriptionId: string;
  paymentId: string;
  signature: string;
}): boolean {
  try {
    return validatePaymentVerification(
      { payment_id: input.paymentId, subscription_id: input.subscriptionId },
      input.signature,
      requireRazorpayKeySecret()
    );
  } catch {
    return false;
  }
}

/**
 * The one place a subscription actually activates the account's Pro plan.
 * Idempotent by construction, same shape as Phase 1's
 * finalizeCreditPurchase: the UPDATE only matches (and only then do we
 * switch account_plans) if the row is still `pending`, so whichever caller
 * gets here first — the client's post-Checkout verify call or the webhook
 * — wins, and the other is a safe no-op.
 */
export async function finalizeSubscriptionActivation(input: {
  razorpaySubscriptionId: string;
}): Promise<{ finalized: boolean }> {
  try {
    const pool = getPool();
    const updated: QueryResult<{
      account_id: string | null;
      org_id: string | null;
      plan_id: string;
      quantity: number;
    }> = await pool.query(
      `UPDATE subscriptions
       SET status = 'active'
       WHERE razorpay_subscription_id = $1 AND status = 'pending'
       RETURNING account_id, org_id::text AS org_id, plan_id::text AS plan_id, quantity`,
      [input.razorpaySubscriptionId]
    );
    const row = updated.rows[0];
    if (!row) {
      return { finalized: false };
    }

    if (row.org_id) {
      // Team plan: the org gets the plan and its paid seat count.
      await pool.query(
        `UPDATE organizations SET plan_id = $2, seats = $3, updated_at = now() WHERE id = $1`,
        [row.org_id, row.plan_id, row.quantity]
      );
      sendTeamPlanEmail({ orgId: row.org_id, event: "activated", seats: row.quantity });
    } else if (row.account_id) {
      const previous = await plansService.getActivePlan(row.account_id);
      await plansService.setActivePlan(row.account_id, "pro", "razorpay");
      sendPlanChangeEmail({ accountId: row.account_id, fromKey: previous?.key ?? null, toKey: "pro" });
    }
    return { finalized: true };
  } catch (error: unknown) {
    logCaught("billing.subscription.service.finalizeSubscriptionActivation", error);
    throw error;
  }
}

/**
 * Grants the subscription plan's included credits for one successful charge.
 * Idempotent per Razorpay payment id: the first charge is reported by both
 * the client verify call and the subscription.charged webhook, renewals only
 * by the webhook — subscription_credit_grants' primary key makes whichever
 * arrives second a no-op. Call after finalizeSubscriptionActivation.
 */
export async function grantSubscriptionCredits(input: {
  razorpaySubscriptionId: string;
  razorpayPaymentId: string;
}): Promise<{ granted: number }> {
  try {
    const result = await withPoolTransaction(async (client: PoolClient): Promise<{ granted: number }> => {
      const sub: QueryResult<{
        account_id: string | null;
        org_id: string | null;
        org_owner_id: string | null;
        quantity: number;
        included_credits: number | null;
      }> = await client.query(
        `SELECT s.account_id, s.org_id::text AS org_id, o.owner_id::text AS org_owner_id,
                s.quantity, p.included_credits
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         LEFT JOIN organizations o ON o.id = s.org_id
         WHERE s.razorpay_subscription_id = $1 AND s.status = 'active'`,
        [input.razorpaySubscriptionId]
      );
      const row = sub.rows[0];
      // Team plans are per seat: included_credits × seats go into the org pool.
      const credits = (row?.included_credits ?? 0) * (row?.org_id ? row.quantity : 1);
      // Ledger / grant rows need an account: the payer for Pro, the org owner for Team.
      const accountId = row?.org_id ? row.org_owner_id : row?.account_id;
      if (!row || !accountId || credits <= 0) return { granted: 0 };

      const claimed: QueryResult<{ razorpay_payment_id: string }> = await client.query(
        `INSERT INTO subscription_credit_grants
           (razorpay_payment_id, razorpay_subscription_id, account_id, credits)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (razorpay_payment_id) DO NOTHING
         RETURNING razorpay_payment_id`,
        [input.razorpayPaymentId, input.razorpaySubscriptionId, accountId, credits]
      );
      if (claimed.rows.length === 0) return { granted: 0 }; // already granted for this payment

      let balanceAfter: number;
      if (row.org_id) {
        await client.query(
          `INSERT INTO org_credit_wallets (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
          [row.org_id]
        );
        const wallet: QueryResult<{ balance: string }> = await client.query(
          `SELECT balance FROM org_credit_wallets WHERE org_id = $1 FOR UPDATE`,
          [row.org_id]
        );
        balanceAfter = Number(wallet.rows[0]?.balance ?? 0) + credits;
        await client.query(
          `UPDATE org_credit_wallets SET balance = $2, updated_at = now() WHERE org_id = $1`,
          [row.org_id, balanceAfter]
        );
      } else {
        await client.query(
          `INSERT INTO credit_wallets (account_id, balance) VALUES ($1, 0)
           ON CONFLICT (account_id) DO NOTHING`,
          [accountId]
        );
        const wallet: QueryResult<{ balance: string }> = await client.query(
          `SELECT balance FROM credit_wallets WHERE account_id = $1 FOR UPDATE`,
          [accountId]
        );
        balanceAfter = Number(wallet.rows[0]?.balance ?? 0) + credits;
        await client.query(
          `UPDATE credit_wallets SET balance = $2, updated_at = now() WHERE account_id = $1`,
          [accountId, balanceAfter]
        );
      }

      await client.query(
        `INSERT INTO credit_ledger (account_id, org_id, amount, reason, balance_after, reference_type, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          accountId,
          row.org_id,
          credits,
          LedgerReason.SUBSCRIPTION_GRANT,
          balanceAfter,
          LedgerReferenceType.SUBSCRIPTION_PAYMENT,
          input.razorpayPaymentId,
        ]
      );
      return { granted: credits };
    });
    // After commit: one invoice per subscription charge.
    if (result.granted > 0) {
      await issueInvoice({ type: "subscription_payment", razorpayPaymentId: input.razorpayPaymentId });
    }
    return result;
  } catch (error: unknown) {
    logCaught("billing.subscription.service.grantSubscriptionCredits", error);
    throw error;
  }
}

/**
 * Best-effort cancel of Razorpay subscriptions that were never paid (an
 * abandoned Team checkout), so they can't be completed later. Failures are
 * logged, not thrown — the subscription may already have expired on
 * Razorpay's side, and our own rows are already gone.
 */
export async function cancelUnpaidRazorpaySubscriptions(razorpaySubscriptionIds: string[]): Promise<void> {
  for (const id of razorpaySubscriptionIds) {
    try {
      await getRazorpayClient().subscriptions.cancel(id, false);
    } catch (error: unknown) {
      logCaught("billing.subscription.service.cancelUnpaidRazorpaySubscriptions", error);
    }
  }
}

/**
 * Fires on subscription.cancelled/completed/halted webhook events. Reverts
 * the account to Free even without a "Cancel" button in our own UI yet —
 * cancelling via Razorpay's own channels still needs to downgrade the
 * account correctly.
 */
export async function handleSubscriptionCancelled(input: {
  razorpaySubscriptionId: string;
  status: "cancelled" | "completed" | "halted";
}): Promise<void> {
  try {
    const pool = getPool();
    const updated: QueryResult<{ account_id: string | null; org_id: string | null; status: string }> =
      await pool.query(
        `UPDATE subscriptions
         SET status = $2
         WHERE razorpay_subscription_id = $1 AND status <> $2
         RETURNING account_id, org_id::text AS org_id, status`,
        [input.razorpaySubscriptionId, input.status]
      );
    const row = updated.rows[0];
    if (!row) return; // already processed, or a subscription id we've never seen

    if (row.org_id) {
      // Team plan ended: no paid seats; the org and its remaining pool credits stay.
      await pool.query(
        `UPDATE organizations SET plan_id = NULL, seats = 0, updated_at = now() WHERE id = $1`,
        [row.org_id]
      );
      sendTeamPlanEmail({ orgId: row.org_id, event: "ended" });
      return;
    }
    if (!row.account_id) return;

    // Only downgrade if this account's active plan is still the one this
    // subscription granted — avoids clobbering a plan they may have since
    // switched to some other way.
    const active = await plansService.getActivePlan(row.account_id);
    if (active?.key === "pro") {
      await plansService.setActivePlan(row.account_id, "free", "razorpay");
      sendPlanChangeEmail({ accountId: row.account_id, fromKey: "pro", toKey: "free" });
    }
  } catch (error: unknown) {
    logCaught("billing.subscription.service.handleSubscriptionCancelled", error);
    throw error;
  }
}
