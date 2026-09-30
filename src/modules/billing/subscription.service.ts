import type { QueryResult } from "pg";
import { validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import * as plansService from "../plans/plans.service";
import { getRazorpayClient, requireRazorpayKeyId, requireRazorpayKeySecret } from "./razorpay-client";

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

// Separate from the catalog's display price_usd_cents — same pattern as
// Phase 1's credit packages: the real charge amount is INR-denominated and
// independent of the USD price shown on the pricing card.
const PRO_SUBSCRIPTION_AMOUNT_INR_PAISE = 149_900; // ₹1,499/mo, confirmed with the user
// Razorpay subscriptions require a finite number of billing cycles — 100
// (~8 years of monthly charges) is the standard way to model "indefinite
// monthly" on their platform. Cancellation works normally regardless of how
// many cycles remain.
const SUBSCRIPTION_TOTAL_COUNT = 100;

export type CreatedSubscriptionOrder = {
  subscriptionId: string;
  keyId: string;
};

/** Creates the Razorpay Plan object for a plan key on first use, memoizing its id on the row. Only "pro" is wired up to a real price in this phase. */
async function ensureRazorpayPlanForKey(planKey: string): Promise<string> {
  const pool = getPool();
  const existing: QueryResult<{ id: number | string; razorpay_plan_id: string | null; display_name: string }> =
    await pool.query(`SELECT id, razorpay_plan_id, display_name FROM plans WHERE key = $1`, [planKey]);
  const row = existing.rows[0];
  if (!row) {
    throw new SubscriptionError(`Unknown plan "${planKey}"`, "not_found");
  }
  if (row.razorpay_plan_id) return row.razorpay_plan_id;

  if (planKey !== "pro") {
    throw new SubscriptionError(`"${planKey}" isn't set up for subscription checkout`, "validation");
  }

  const plan = await getRazorpayClient().plans.create({
    period: "monthly",
    interval: 1,
    item: {
      name: `${row.display_name} (monthly)`,
      amount: PRO_SUBSCRIPTION_AMOUNT_INR_PAISE,
      currency: "INR",
    },
  });

  await pool.query(`UPDATE plans SET razorpay_plan_id = $2 WHERE key = $1`, [planKey, plan.id]);
  return plan.id;
}

/** Starts a Pro upgrade: creates the Razorpay Subscription and records it as `pending`. */
export async function createProSubscription(accountId: string): Promise<CreatedSubscriptionOrder> {
  try {
    const planId = await ensureRazorpayPlanForKey("pro");
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
      `INSERT INTO subscriptions (account_id, plan_id, razorpay_subscription_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [accountId, proPlanId, subscription.id]
    );

    return { subscriptionId: subscription.id, keyId: requireRazorpayKeyId() };
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) throw error;
    logCaught("billing.subscription.service.createProSubscription", error);
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
    const updated: QueryResult<{ account_id: string }> = await pool.query(
      `UPDATE subscriptions
       SET status = 'active'
       WHERE razorpay_subscription_id = $1 AND status = 'pending'
       RETURNING account_id`,
      [input.razorpaySubscriptionId]
    );
    const row = updated.rows[0];
    if (!row) {
      return { finalized: false };
    }

    await plansService.setActivePlan(row.account_id, "pro", "razorpay");
    return { finalized: true };
  } catch (error: unknown) {
    logCaught("billing.subscription.service.finalizeSubscriptionActivation", error);
    throw error;
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
    const updated: QueryResult<{ account_id: string; status: string }> = await pool.query(
      `UPDATE subscriptions
       SET status = $2
       WHERE razorpay_subscription_id = $1 AND status <> $2
       RETURNING account_id, status`,
      [input.razorpaySubscriptionId, input.status]
    );
    const row = updated.rows[0];
    if (!row) return; // already processed, or a subscription id we've never seen

    // Only downgrade if this account's active plan is still the one this
    // subscription granted — avoids clobbering a plan they may have since
    // switched to some other way.
    const active = await plansService.getActivePlan(row.account_id);
    if (active?.key === "pro") {
      await plansService.setActivePlan(row.account_id, "free", "razorpay");
    }
  } catch (error: unknown) {
    logCaught("billing.subscription.service.handleSubscriptionCancelled", error);
    throw error;
  }
}
