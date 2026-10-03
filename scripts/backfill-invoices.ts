/**
 * Issues GST invoices for payments that don't have one yet — payments made
 * before the seller GST details were set, or whose invoice failed to issue (logged by
 * invoices.service). Safe to re-run: issuing is idempotent per payment.
 *
 *   npx tsx scripts/backfill-invoices.ts            # dry run: lists what's missing
 *   npx tsx scripts/backfill-invoices.ts --apply    # issues them
 *
 * Invoices are numbered and dated when issued (today), not at payment time.
 */
import "dotenv/config";
import { getPool } from "../src/infrastructure/db/pool";
import { issueInvoice } from "../src/modules/billing/invoices.service";
import { getEffectiveSeller } from "../src/modules/billing/seller-settings.service";

async function main() {
  const apply = process.argv.includes("--apply");
  const pool = getPool();
  const seller = await getEffectiveSeller();
  if (!seller.legalName || !seller.gstin) {
    console.error(
      "Seller GST details aren't set — add them on the admin panel's Invoicing page (or SELLER_* in backend/.env)."
    );
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const purchases = await pool.query<{ id: string; created_at: Date }>(
    `SELECT p.id::text AS id, p.created_at FROM credit_purchases p
     WHERE p.status = 'succeeded'
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.source_type = 'credit_purchase' AND i.source_id = p.id::text)
     ORDER BY p.created_at`
  );
  const payments = await pool.query<{ razorpay_payment_id: string; created_at: Date }>(
    `SELECT g.razorpay_payment_id, g.created_at FROM subscription_credit_grants g
     WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.source_type = 'subscription_payment' AND i.source_id = g.razorpay_payment_id)
     ORDER BY g.created_at`
  );

  console.log(`Missing invoices: ${purchases.rows.length} credit purchases, ${payments.rows.length} subscription charges.`);
  if (!apply) {
    console.log("Dry run — re-run with --apply to issue them.");
    await pool.end();
    return;
  }

  let issued = 0;
  for (const p of purchases.rows) {
    if (await issueInvoice({ type: "credit_purchase", purchaseId: p.id })) issued++;
  }
  for (const g of payments.rows) {
    if (await issueInvoice({ type: "subscription_payment", razorpayPaymentId: g.razorpay_payment_id })) issued++;
  }
  console.log(`Issued ${issued} invoice(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
