import { randomUUID } from "crypto";
import type { QueryResult } from "pg";
// Not re-exposed as a static on the Razorpay class (only validateWebhookSignature
// is) — imported directly from the SDK's own utils module instead of
// hand-rolling the HMAC check ourselves.
import { validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import { LedgerReason, LedgerReferenceType } from "../../config/ledger-reasons";
import { getRazorpayClient, requireRazorpayKeyId, requireRazorpayKeySecret } from "./razorpay-client";
import { findCreditPackage } from "./credit-packages";

export type BillingErrorKind = "validation" | "not_found";

export class BillingError extends Error {
  constructor(
    message: string,
    readonly kind: BillingErrorKind
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export type CreatedPurchaseOrder = {
  orderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
  packageLabel: string;
};

/** Starts a purchase: creates a Razorpay Order, records it as `pending`, and returns what the client needs to open Checkout. */
export async function createPurchaseOrder(input: {
  accountId: string;
  packageId: string;
}): Promise<CreatedPurchaseOrder> {
  const pkg = findCreditPackage(input.packageId);
  if (!pkg) {
    throw new BillingError(`Unknown credit package "${input.packageId}"`, "validation");
  }

  try {
    const order = await getRazorpayClient().orders.create({
      amount: pkg.amountInrPaise,
      currency: "INR",
      receipt: randomUUID().slice(0, 40),
      notes: { accountId: input.accountId, packageId: pkg.id },
    });

    const pool = getPool();
    await pool.query(
      `INSERT INTO credit_purchases (account_id, razorpay_order_id, credits, amount_usd_cents, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [input.accountId, order.id, pkg.credits, pkg.amountInrPaise]
    );

    return {
      orderId: order.id,
      amountPaise: pkg.amountInrPaise,
      currency: "INR",
      keyId: requireRazorpayKeyId(),
      packageLabel: pkg.label,
    };
  } catch (error: unknown) {
    if (error instanceof BillingError) throw error;
    logCaught("billing.billing.service.createPurchaseOrder", error);
    throw error;
  }
}

/**
 * The one place a purchase actually becomes credits. Idempotent by
 * construction: the UPDATE only matches (and only then do we touch the
 * ledger) if the row is still `pending`, so whichever caller gets here
 * first — the client's post-Checkout verify call or the webhook — wins,
 * and the other is a safe no-op. Never called with unverified data (see
 * billing.controller.ts / webhook signature checks upstream of both call sites).
 */
export async function finalizeCreditPurchase(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
}): Promise<{ finalized: boolean }> {
  try {
    const pool = getPool();

    const updated: QueryResult<{
      id: string;
      account_id: string;
      credits: string;
    }> = await pool.query(
      `UPDATE credit_purchases
       SET status = 'succeeded', razorpay_payment_id = $2
       WHERE razorpay_order_id = $1 AND status = 'pending'
       RETURNING id, account_id, credits`,
      [input.razorpayOrderId, input.razorpayPaymentId]
    );
    const row = updated.rows[0];
    if (!row) {
      // Either already finalized by the other path, or an order id we've
      // never seen — either way, nothing more to do.
      return { finalized: false };
    }

    const credits = Number(row.credits);

    await pool.query(
      `INSERT INTO credit_wallets (account_id, balance) VALUES ($1, 0)
       ON CONFLICT (account_id) DO NOTHING`,
      [row.account_id]
    );

    const walletLock: QueryResult<{ balance: string }> = await pool.query(
      `SELECT balance FROM credit_wallets WHERE account_id = $1 FOR UPDATE`,
      [row.account_id]
    );
    const balanceAfter = Number(walletLock.rows[0]?.balance ?? 0) + credits;

    await pool.query(
      `INSERT INTO credit_ledger (account_id, amount, reason, balance_after, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.account_id,
        credits,
        LedgerReason.PURCHASE,
        balanceAfter,
        LedgerReferenceType.CREDIT_PURCHASE,
        row.id,
      ]
    );
    await pool.query(
      `UPDATE credit_wallets SET balance = $2, updated_at = now() WHERE account_id = $1`,
      [row.account_id, balanceAfter]
    );

    return { finalized: true };
  } catch (error: unknown) {
    logCaught("billing.billing.service.finalizeCreditPurchase", error);
    throw error;
  }
}

/**
 * Client-side fast path: Razorpay Checkout's success callback hands back
 * order_id/payment_id/signature. Verified via the SDK's own
 * validatePaymentVerification rather than a hand-rolled HMAC check —
 * payment-signature verification is exactly the kind of code worth leaning
 * on a vetted library for instead of reimplementing.
 */
export function verifyOrderPaymentSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  try {
    return validatePaymentVerification(
      { order_id: input.orderId, payment_id: input.paymentId },
      input.signature,
      requireRazorpayKeySecret()
    );
  } catch {
    return false;
  }
}
