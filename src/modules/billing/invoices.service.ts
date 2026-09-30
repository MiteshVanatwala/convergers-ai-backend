import type { PoolClient, QueryResult } from "pg";
import { GST_STATES, type BillingProfile } from "@convergers-ai/shared-types";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";
import { getEffectiveSeller } from "./seller-settings.service";

/** GST on these services, in basis points. Prices are GST-inclusive. */
export const GST_RATE_BP = 1800;

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export function isValidGstin(gstin: string): boolean {
  return GSTIN_RE.test(gstin);
}

export function stateName(code: string | null | undefined): string | null {
  return GST_STATES.find((s) => s.code === code)?.name ?? null;
}

export type GstSplit = {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
};

/**
 * Splits a GST-inclusive total. Intra-state (same state) → CGST + SGST halves;
 * inter-state → IGST. Rounds the taxable value to the paisa and puts the
 * rounding into the tax, so the parts always add up to the total exactly.
 */
export function splitInclusiveGst(totalPaise: number, sellerState: string, placeOfSupply: string): GstSplit {
  const taxablePaise = Math.round((totalPaise * 10_000) / (10_000 + GST_RATE_BP));
  const tax = totalPaise - taxablePaise;
  if (sellerState === placeOfSupply) {
    const cgstPaise = Math.floor(tax / 2);
    return { taxablePaise, cgstPaise, sgstPaise: tax - cgstPaise, igstPaise: 0 };
  }
  return { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
}

/** Indian financial year (Apr–Mar, IST) as a 4-digit tag: 2026-09-30 → "2627". */
export function financialYearTag(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60_000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1; // April = month 3
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "CAI2627-000042" — at most 4 + 4 + 1 + 6 = 15 chars (GST allows 16). */
export function formatInvoiceNumber(prefix: string, fy: string, n: number): string {
  return `${prefix}${fy}-${String(n).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Billing profiles (buyer details)
// ---------------------------------------------------------------------------

type ProfileOwner = { accountId: string } | { orgId: string };

type ProfileRow = {
  legal_name: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  state_code: string | null;
};

function mapProfile(row: ProfileRow): BillingProfile {
  return {
    legalName: row.legal_name,
    gstin: row.gstin,
    address: row.address,
    city: row.city,
    postalCode: row.postal_code,
    stateCode: row.state_code,
  };
}

/** One printable line: "12 MG Road, Pune 411001". */
export function formatBillingAddress(p: Pick<BillingProfile, "address" | "city" | "postalCode">): string | null {
  const cityLine = [p.city, p.postalCode].filter(Boolean).join(" ");
  const parts = [p.address, cityLine].filter((x): x is string => Boolean(x && x.trim()));
  return parts.length ? parts.join(", ") : null;
}

export async function getBillingProfile(
  owner: ProfileOwner,
  db: PoolClient | ReturnType<typeof getPool> = getPool()
): Promise<BillingProfile | null> {
  try {
    const [column, id] = "orgId" in owner ? ["org_id", owner.orgId] : ["account_id", owner.accountId];
    const result: QueryResult<ProfileRow> = await db.query(
      `SELECT legal_name, gstin, address, city, postal_code, state_code FROM billing_profiles WHERE ${column} = $1`,
      [id]
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  } catch (error: unknown) {
    logCaught("billing.invoices.service.getBillingProfile", error);
    throw error;
  }
}

/** Upsert; the state is taken from the GSTIN when one is given. Validate before calling. */
export async function saveBillingProfile(owner: ProfileOwner, profile: BillingProfile): Promise<BillingProfile> {
  try {
    const stateCode = profile.gstin ? profile.gstin.slice(0, 2) : profile.stateCode;
    const [column, id] = "orgId" in owner ? ["org_id", owner.orgId] : ["account_id", owner.accountId];
    const result: QueryResult<ProfileRow> = await getPool().query(
      `INSERT INTO billing_profiles (${column}, legal_name, gstin, address, city, postal_code, state_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (${column}) DO UPDATE
       SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, address = EXCLUDED.address,
           city = EXCLUDED.city, postal_code = EXCLUDED.postal_code,
           state_code = EXCLUDED.state_code, updated_at = now()
       RETURNING legal_name, gstin, address, city, postal_code, state_code`,
      [id, profile.legalName, profile.gstin, profile.address, profile.city, profile.postalCode, stateCode]
    );
    const row = result.rows[0];
    if (!row) throw new Error("billing_profiles upsert returned no row");
    return mapProfile(row);
  } catch (error: unknown) {
    logCaught("billing.invoices.service.saveBillingProfile", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Issuing invoices
// ---------------------------------------------------------------------------

type InvoiceSource =
  | { type: "credit_purchase"; purchaseId: string }
  | { type: "subscription_payment"; razorpayPaymentId: string };

type InvoiceLine = {
  accountId: string;
  orgId: string | null;
  description: string;
  quantity: number;
  unitAmountPaise: number;
};

/** What a payment was for — read from the purchase / subscription it came from. */
async function loadInvoiceLine(client: PoolClient, source: InvoiceSource): Promise<InvoiceLine | null> {
  if (source.type === "credit_purchase") {
    const r: QueryResult<{ account_id: string; org_id: string | null; credits: string; amount: number }> =
      await client.query(
        `SELECT account_id::text AS account_id, org_id::text AS org_id, credits,
                amount_usd_cents AS amount  -- legacy name: holds INR paise for Razorpay purchases
         FROM credit_purchases WHERE id = $1 AND status = 'succeeded'`,
        [source.purchaseId]
      );
    const row = r.rows[0];
    if (!row) return null;
    const credits = Number(row.credits).toLocaleString("en-IN");
    return {
      accountId: row.account_id,
      orgId: row.org_id,
      description: row.org_id
        ? `Convergers AI credits — ${credits} credits (organization pool)`
        : `Convergers AI credits — ${credits} credits`,
      quantity: 1,
      unitAmountPaise: row.amount,
    };
  }

  const r: QueryResult<{
    grant_account_id: string;
    org_id: string | null;
    quantity: number;
    unit_amount_paise: number | null;
    price_inr_paise: number | null;
    plan_name: string;
  }> = await client.query(
    `SELECT g.account_id::text AS grant_account_id, s.org_id::text AS org_id, s.quantity,
            s.unit_amount_paise, p.price_inr_paise, p.display_name AS plan_name
     FROM subscription_credit_grants g
     JOIN subscriptions s ON s.razorpay_subscription_id = g.razorpay_subscription_id
     JOIN plans p ON p.id = s.plan_id
     WHERE g.razorpay_payment_id = $1`,
    [source.razorpayPaymentId]
  );
  const row = r.rows[0];
  const unit = row?.unit_amount_paise ?? row?.price_inr_paise;
  if (!row || !unit) return null;
  const quantity = row.org_id ? row.quantity : 1;
  return {
    accountId: row.grant_account_id,
    orgId: row.org_id,
    description: row.org_id
      ? `Convergers AI ${row.plan_name} plan — monthly, per seat`
      : `Convergers AI ${row.plan_name} plan — monthly subscription`,
    quantity,
    unitAmountPaise: unit,
  };
}

/**
 * Issues the GST invoice for one payment. Idempotent (unique on source) and
 * never throws: invoicing must not break a payment that already succeeded —
 * a failure is logged and can be retried with scripts/backfill-invoices.ts.
 * No-op when the seller isn't configured (admin Invoicing page, or SELLER_* env vars).
 */
export async function issueInvoice(source: InvoiceSource): Promise<{ invoiceNumber: string } | null> {
  try {
    // Saved on the admin Invoicing page, with SELLER_* env vars as fallback.
    const { legalName, gstin, address, sacCode, invoicePrefix } = await getEffectiveSeller();
    if (!legalName || !gstin || !isValidGstin(gstin)) return null;

    return await withPoolTransaction(async (client: PoolClient) => {
      const sourceId = source.type === "credit_purchase" ? source.purchaseId : source.razorpayPaymentId;
      const existing: QueryResult<{ invoice_number: string }> = await client.query(
        `SELECT invoice_number FROM invoices WHERE source_type = $1 AND source_id = $2`,
        [source.type, sourceId]
      );
      if (existing.rows[0]) return { invoiceNumber: existing.rows[0].invoice_number };

      const line = await loadInvoiceLine(client, source);
      if (!line) return null;

      const profile = await getBillingProfile(line.orgId ? { orgId: line.orgId } : { accountId: line.accountId }, client);
      const account: QueryResult<{ name: string | null; email: string }> = await client.query(
        `SELECT name, email FROM accounts WHERE id = $1`,
        [line.accountId]
      );
      const sellerState = gstin.slice(0, 2);
      // Place of supply: the buyer's state if known, otherwise the seller's (unregistered buyer, no address).
      const placeOfSupply = profile?.gstin?.slice(0, 2) ?? profile?.stateCode ?? sellerState;
      const buyer = {
        legalName: profile?.legalName ?? account.rows[0]?.name ?? account.rows[0]?.email ?? "Customer",
        gstin: profile?.gstin ?? null,
        address: profile ? formatBillingAddress(profile) : null,
        stateCode: placeOfSupply,
        stateName: stateName(placeOfSupply),
        email: account.rows[0]?.email ?? null,
      };
      const seller = { legalName, gstin, address: address ?? null, stateCode: sellerState, stateName: stateName(sellerState) };

      const totalPaise = line.unitAmountPaise * line.quantity;
      const split = splitInclusiveGst(totalPaise, sellerState, placeOfSupply);

      // Consecutive numbering per financial year; the row lock serializes concurrent issuers.
      const fy = financialYearTag(new Date());
      await client.query(
        `INSERT INTO invoice_sequences (financial_year) VALUES ($1) ON CONFLICT (financial_year) DO NOTHING`,
        [fy]
      );
      const seq: QueryResult<{ last_number: number }> = await client.query(
        `UPDATE invoice_sequences SET last_number = last_number + 1 WHERE financial_year = $1 RETURNING last_number`,
        [fy]
      );
      const invoiceNumber = formatInvoiceNumber(invoicePrefix, fy, seq.rows[0]?.last_number ?? 1);

      await client.query(
        `INSERT INTO invoices (
           invoice_number, account_id, org_id, source_type, source_id, description, quantity,
           unit_amount_paise, total_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise,
           gst_rate_bp, sac_code, place_of_supply, seller, buyer
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          invoiceNumber,
          line.accountId,
          line.orgId,
          source.type,
          sourceId,
          line.description,
          line.quantity,
          line.unitAmountPaise,
          totalPaise,
          split.taxablePaise,
          split.cgstPaise,
          split.sgstPaise,
          split.igstPaise,
          GST_RATE_BP,
          sacCode ?? null,
          placeOfSupply,
          JSON.stringify(seller),
          JSON.stringify(buyer),
        ]
      );
      return { invoiceNumber };
    });
  } catch (error: unknown) {
    logCaught("billing.invoices.service.issueInvoice", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading invoices
// ---------------------------------------------------------------------------

export type InvoiceRow = {
  id: string;
  invoice_number: string;
  account_id: string;
  org_id: string | null;
  issued_at: Date;
  description: string;
  quantity: number;
  unit_amount_paise: number;
  total_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  gst_rate_bp: number;
  sac_code: string | null;
  place_of_supply: string;
  seller: { legalName: string; gstin: string; address: string | null; stateCode: string; stateName: string | null };
  buyer: {
    legalName: string;
    gstin: string | null;
    address: string | null;
    stateCode: string;
    stateName: string | null;
    email: string | null;
  };
};

const INVOICE_COLUMNS = `id::text AS id, invoice_number, account_id::text AS account_id, org_id::text AS org_id,
  issued_at, description, quantity, unit_amount_paise, total_paise, taxable_paise, cgst_paise,
  sgst_paise, igst_paise, gst_rate_bp, sac_code, place_of_supply, seller, buyer`;

/** The caller's personal invoices plus, for org admins, the org's invoices. */
export async function listInvoices(accountId: string, adminOfOrgId: string | null): Promise<InvoiceRow[]> {
  try {
    const result: QueryResult<InvoiceRow> = await getPool().query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices
       WHERE (account_id = $1 AND org_id IS NULL) OR ($2::uuid IS NOT NULL AND org_id = $2::uuid)
       ORDER BY issued_at DESC LIMIT 100`,
      [accountId, adminOfOrgId]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("billing.invoices.service.listInvoices", error);
    throw error;
  }
}

export async function getInvoice(id: string): Promise<InvoiceRow | null> {
  try {
    const result: QueryResult<InvoiceRow> = await getPool().query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("billing.invoices.service.getInvoice", error);
    throw error;
  }
}
