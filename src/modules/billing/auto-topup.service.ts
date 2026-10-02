import { randomUUID } from "crypto";
import type { PoolClient, QueryResult } from "pg";
import type { AutoTopUp } from "@convergers-ai/shared-types";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";
import { BillingError, type CreatedPurchaseOrder } from "./billing.service";
import { findCreditPackage } from "./credit-packages";
import { getRazorpayClient, requireRazorpayKeyId } from "./razorpay-client";

/**
 * Pay-as-you-go auto top-up (personal wallets only).
 *
 * Setup: the first pack is bought in Checkout with `recurring: 1`, which saves
 * the card as a Razorpay card-on-file token ("as_presented" — variable amount,
 * charged when we present it). After that, a usage debit that leaves the
 * balance under the threshold charges the same pack to that token. The charge
 * becomes credits through the normal credit_purchases path (webhook
 * payment.captured → finalizeCreditPurchase), so invoices and the ledger work
 * exactly as for a manual purchase.
 */

/** Indian card-on-file limit without extra authentication per charge. */
const TOKEN_MAX_AMOUNT_PAISE = 1_500_000;
const TOKEN_VALIDITY_SECONDS = 5 * 365 * 24 * 60 * 60;
/** Safety cap on automatic charges per calendar month. */
export const MAX_AUTO_TOPUPS_PER_MONTH = 5;
/** Card recurring debits settle after a pre-debit notice, so a charge can stay pending for a day or more. */
const PENDING_WINDOW = "48 hours";
const CONTACT_RE = /^\+?[0-9]{10,13}$/;

type SettingsRow = {
  status: AutoTopUp["status"];
  package_id: string;
  threshold_credits: number;
  contact: string;
  razorpay_customer_id: string;
  razorpay_token_id: string | null;
  card_network: string | null;
  card_last4: string | null;
  last_error: string | null;
};

function toView(row: SettingsRow): AutoTopUp {
  const pkg = findCreditPackage(row.package_id);
  return {
    status: row.status,
    packageId: row.package_id,
    packageLabel: pkg?.label ?? row.package_id,
    thresholdCredits: row.threshold_credits,
    cardNetwork: row.card_network,
    cardLast4: row.card_last4,
    lastError: row.last_error,
  };
}

async function loadSettings(accountId: string, db: Pick<PoolClient, "query"> = getPool()): Promise<SettingsRow | null> {
  const result: QueryResult<SettingsRow> = await db.query(
    `SELECT status, package_id, threshold_credits, contact, razorpay_customer_id, razorpay_token_id,
            card_network, card_last4, last_error
     FROM auto_topup_settings WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0] ?? null;
}

export async function getAutoTopUp(accountId: string): Promise<AutoTopUp | null> {
  const row = await loadSettings(accountId);
  return row ? toView(row) : null;
}

function validate(input: { packageId: string; thresholdCredits: number }) {
  const pkg = findCreditPackage(input.packageId);
  if (!pkg) throw new BillingError(`Unknown credit package "${input.packageId}"`, "validation");
  if (!Number.isInteger(input.thresholdCredits) || input.thresholdCredits < 100 || input.thresholdCredits > 1_000_000) {
    throw new BillingError("Choose a threshold between 100 and 1,000,000 credits.", "validation");
  }
  return pkg;
}

export type CreatedAutoTopUpOrder = CreatedPurchaseOrder & { customerId: string };

/** Starts setup: a card-only Razorpay order that buys the first pack and saves the card for later charges. */
export async function startAutoTopUpSetup(input: {
  accountId: string;
  email: string;
  name: string | null;
  packageId: string;
  thresholdCredits: number;
  contact: string;
}): Promise<CreatedAutoTopUpOrder> {
  const pkg = validate(input);
  const contact = input.contact.replace(/[\s-]/g, "");
  if (!CONTACT_RE.test(contact)) {
    throw new BillingError("Enter a valid mobile number.", "validation");
  }

  try {
    const razorpay = getRazorpayClient();
    const existing = await loadSettings(input.accountId);
    // fail_existing 0 returns the existing customer for this email/contact instead of erroring.
    const customerId =
      existing?.razorpay_customer_id ??
      (
        await razorpay.customers.create({
          name: input.name ?? input.email,
          email: input.email,
          contact,
          fail_existing: 0,
          notes: { accountId: input.accountId },
        })
      ).id;

    const order = await razorpay.orders.create({
      amount: pkg.amountInrPaise,
      currency: "INR",
      method: "card",
      customer_id: customerId,
      payment_capture: true,
      receipt: randomUUID().slice(0, 40),
      notes: { accountId: input.accountId, packageId: pkg.id, purpose: "auto_topup_setup" },
      token: {
        max_amount: TOKEN_MAX_AMOUNT_PAISE,
        expire_at: Math.floor(Date.now() / 1000) + TOKEN_VALIDITY_SECONDS,
        frequency: "as_presented",
      },
    });

    await withPoolTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO credit_purchases (account_id, razorpay_order_id, credits, amount_usd_cents, status, source)
         VALUES ($1, $2, $3, $4, 'pending', 'auto_topup_setup')`,
        [input.accountId, order.id, pkg.credits, pkg.amountInrPaise]
      );
      // A re-setup (new card) keeps the old token working until the new one is saved.
      await client.query(
        `INSERT INTO auto_topup_settings (account_id, package_id, threshold_credits, contact, razorpay_customer_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id) DO UPDATE
           SET package_id = EXCLUDED.package_id,
               threshold_credits = EXCLUDED.threshold_credits,
               contact = EXCLUDED.contact,
               razorpay_customer_id = EXCLUDED.razorpay_customer_id,
               updated_at = now()`,
        [input.accountId, pkg.id, input.thresholdCredits, contact, customerId]
      );
    });

    return {
      orderId: order.id,
      amountPaise: pkg.amountInrPaise,
      currency: "INR",
      keyId: requireRazorpayKeyId(),
      packageLabel: pkg.label,
      customerId,
    };
  } catch (error: unknown) {
    if (error instanceof BillingError) throw error;
    logCaught("billing.auto-topup.startAutoTopUpSetup", error);
    throw error;
  }
}

/**
 * Called once a setup payment is captured (client verify or webhook): stores
 * the saved card's token and turns auto top-up on. Safe to call twice.
 */
export async function completeAutoTopUpSetup(input: { razorpayOrderId: string; razorpayPaymentId: string }): Promise<void> {
  try {
    const pool = getPool();
    const purchase: QueryResult<{ account_id: string }> = await pool.query(
      `SELECT account_id FROM credit_purchases WHERE razorpay_order_id = $1 AND source = 'auto_topup_setup'`,
      [input.razorpayOrderId]
    );
    const accountId = purchase.rows[0]?.account_id;
    if (!accountId) return;

    const payment = await getRazorpayClient().payments.fetch(input.razorpayPaymentId);
    const tokenId = payment.token_id ?? null;
    if (!tokenId) {
      await pool.query(
        `UPDATE auto_topup_settings
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE account_id = $1 AND razorpay_token_id IS NULL`,
        [accountId, "Your card wasn't saved for automatic payments. Try another card."]
      );
      return;
    }
    await pool.query(
      `UPDATE auto_topup_settings
       SET status = 'active', razorpay_token_id = $2, card_network = $3, card_last4 = $4,
           last_error = NULL, updated_at = now()
       WHERE account_id = $1`,
      [accountId, tokenId, payment.card?.network ?? null, payment.card?.last4 ?? null]
    );
  } catch (error: unknown) {
    logCaught("billing.auto-topup.completeAutoTopUpSetup", error);
    throw error;
  }
}

/** Change the pack or threshold, or pause / resume. */
export async function updateAutoTopUp(
  accountId: string,
  patch: { packageId?: string; thresholdCredits?: number; enabled?: boolean }
): Promise<AutoTopUp> {
  const row = await loadSettings(accountId);
  if (!row) throw new BillingError("Auto top-up isn't set up.", "not_found");
  const packageId = patch.packageId ?? row.package_id;
  const thresholdCredits = patch.thresholdCredits ?? row.threshold_credits;
  validate({ packageId, thresholdCredits });

  let status = row.status;
  if (patch.enabled === false) status = "paused";
  if (patch.enabled === true) {
    if (!row.razorpay_token_id) throw new BillingError("Add a card first.", "validation");
    status = "active";
  }

  const result: QueryResult<SettingsRow> = await getPool().query(
    `UPDATE auto_topup_settings
     SET package_id = $2, threshold_credits = $3, status = $4,
         last_error = CASE WHEN $4 = 'active' THEN NULL ELSE last_error END, updated_at = now()
     WHERE account_id = $1
     RETURNING status, package_id, threshold_credits, contact, razorpay_customer_id, razorpay_token_id,
               card_network, card_last4, last_error`,
    [accountId, packageId, thresholdCredits, status]
  );
  return toView(result.rows[0]!);
}

/** Turns auto top-up off and removes the saved card from Razorpay. */
export async function removeAutoTopUp(accountId: string): Promise<void> {
  const row = await loadSettings(accountId);
  if (!row) return;
  if (row.razorpay_token_id) {
    try {
      await getRazorpayClient().customers.deleteToken(row.razorpay_customer_id, row.razorpay_token_id);
    } catch (error: unknown) {
      // The row goes anyway: without it we never charge the token again.
      logCaught("billing.auto-topup.removeAutoTopUp.deleteToken", error);
    }
  }
  await getPool().query(`DELETE FROM auto_topup_settings WHERE account_id = $1`, [accountId]);
}

type PendingCharge = {
  orderId: string;
  amountPaise: number;
  email: string;
  contact: string;
  customerId: string;
  tokenId: string;
};

/**
 * After a personal usage debit: charges the saved card when the balance is
 * under the threshold. Never throws — callers fire and forget.
 */
export async function maybeAutoTopUp(accountId: string, balance: number): Promise<void> {
  try {
    const charge = await withPoolTransaction(async (client: PoolClient): Promise<PendingCharge | null> => {
      // Row lock: two debits finishing together must not both charge the card.
      const locked: QueryResult<SettingsRow & { email: string }> = await client.query(
        `SELECT s.status, s.package_id, s.threshold_credits, s.contact, s.razorpay_customer_id,
                s.razorpay_token_id, s.card_network, s.card_last4, s.last_error, a.email::text AS email
         FROM auto_topup_settings s JOIN accounts a ON a.id = s.account_id
         WHERE s.account_id = $1 AND s.status = 'active' AND s.razorpay_token_id IS NOT NULL
           AND s.threshold_credits > $2
         FOR UPDATE OF s`,
        [accountId, balance]
      );
      const row = locked.rows[0];
      if (!row?.razorpay_token_id) return null;
      const pkg = findCreditPackage(row.package_id);
      if (!pkg) return null;

      const recent: QueryResult<{ pending: string; this_month: string }> = await client.query(
        `SELECT count(*) FILTER (WHERE status = 'pending' AND created_at > now() - $2::interval) AS pending,
                count(*) FILTER (WHERE status <> 'failed' AND created_at >= date_trunc('month', now())) AS this_month
         FROM credit_purchases WHERE account_id = $1 AND source = 'auto_topup'`,
        [accountId, PENDING_WINDOW]
      );
      if (Number(recent.rows[0]?.pending ?? 0) > 0) return null;
      if (Number(recent.rows[0]?.this_month ?? 0) >= MAX_AUTO_TOPUPS_PER_MONTH) return null;

      const order = await getRazorpayClient().orders.create({
        amount: pkg.amountInrPaise,
        currency: "INR",
        payment_capture: true,
        receipt: randomUUID().slice(0, 40),
        notes: { accountId, packageId: pkg.id, purpose: "auto_topup" },
      });
      await client.query(
        `INSERT INTO credit_purchases (account_id, razorpay_order_id, credits, amount_usd_cents, status, source)
         VALUES ($1, $2, $3, $4, 'pending', 'auto_topup')`,
        [accountId, order.id, pkg.credits, pkg.amountInrPaise]
      );
      return {
        orderId: order.id,
        amountPaise: pkg.amountInrPaise,
        email: row.email,
        contact: row.contact,
        customerId: row.razorpay_customer_id,
        tokenId: row.razorpay_token_id,
      };
    });
    if (!charge) return;

    try {
      await getRazorpayClient().payments.createRecurringPayment({
        email: charge.email,
        contact: charge.contact,
        amount: charge.amountPaise,
        currency: "INR",
        order_id: charge.orderId,
        customer_id: charge.customerId,
        token: charge.tokenId,
        recurring: "1",
        description: "Aikya credits (auto top-up)",
        notes: { accountId, purpose: "auto_topup" },
      });
      // Credits arrive with the payment.captured webhook.
    } catch (error: unknown) {
      logCaught("billing.auto-topup.maybeAutoTopUp.charge", error);
      await markAutoTopUpFailed(charge.orderId, razorpayErrorMessage(error));
    }
  } catch (error: unknown) {
    logCaught("billing.auto-topup.maybeAutoTopUp", error);
  }
}

function razorpayErrorMessage(error: unknown): string {
  const description = (error as { error?: { description?: unknown } })?.error?.description;
  return typeof description === "string" && description ? description : "The payment couldn't be completed.";
}

/**
 * A payment for one of our orders failed (webhook payment.failed, or the
 * recurring charge call itself). Marks the purchase failed; for an automatic
 * charge, also stops auto top-up until the user fixes the card.
 */
export async function markAutoTopUpFailed(razorpayOrderId: string, reason: string): Promise<void> {
  try {
    await withPoolTransaction(async (client: PoolClient) => {
      const updated: QueryResult<{ account_id: string; source: string }> = await client.query(
        `UPDATE credit_purchases SET status = 'failed', failure_reason = $2
         WHERE razorpay_order_id = $1 AND status = 'pending' AND source = 'auto_topup'
         RETURNING account_id, source`,
        [razorpayOrderId, reason.slice(0, 500)]
      );
      const row = updated.rows[0];
      if (!row) return;
      await client.query(
        `UPDATE auto_topup_settings SET status = 'failed', last_error = $2, updated_at = now()
         WHERE account_id = $1 AND status = 'active'`,
        [row.account_id, `Automatic payment failed: ${reason}`.slice(0, 500)]
      );
    });
  } catch (error: unknown) {
    logCaught("billing.auto-topup.markAutoTopUpFailed", error);
  }
}
