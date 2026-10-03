import type { PoolClient, QueryResult } from "pg";
import { loadEnv } from "../../config/env";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";
import { appendAdminAudit } from "../admin/admin-audit.service";

/**
 * The seller (supplier) printed on GST invoices. Saved on the admin panel's
 * Invoicing page (seller_settings); any field not saved there falls back to
 * the SELLER_* / INVOICE_* env vars.
 */
export type SellerConfig = {
  legalName: string | undefined;
  gstin: string | undefined;
  address: string | undefined;
  sacCode: string | undefined;
  invoicePrefix: string;
};

export type SellerSettingsInput = {
  legalName: string | null;
  gstin: string | null;
  address: string | null;
  sacCode: string | null;
  invoicePrefix: string | null;
};

type Row = {
  legal_name: string | null;
  gstin: string | null;
  address: string | null;
  sac_code: string | null;
  invoice_prefix: string | null;
  updated_at: Date;
};

const DEFAULT_PREFIX = "CAI";

async function readRow(): Promise<{ tableReady: boolean; row: Row | null }> {
  // Tolerate the table not existing yet (seller_settings_v1.sql not applied) — env still works.
  const exists: QueryResult<{ ok: boolean }> = await getPool().query(
    `SELECT to_regclass('public.seller_settings') IS NOT NULL AS ok`
  );
  if (!exists.rows[0]?.ok) return { tableReady: false, row: null };
  const result: QueryResult<Row> = await getPool().query(
    `SELECT legal_name, gstin, address, sac_code, invoice_prefix, updated_at FROM seller_settings WHERE id`
  );
  return { tableReady: true, row: result.rows[0] ?? null };
}

/** Saved values over env fallbacks — what invoices actually use. */
export async function getEffectiveSeller(): Promise<SellerConfig> {
  try {
    const env = loadEnv().seller;
    const { row } = await readRow();
    return {
      legalName: row?.legal_name ?? env.legalName,
      gstin: row?.gstin ?? env.gstin,
      address: row?.address ?? env.address,
      sacCode: row?.sac_code ?? env.sacCode,
      invoicePrefix: row?.invoice_prefix ?? (env.invoicePrefix || DEFAULT_PREFIX),
    };
  } catch (error: unknown) {
    logCaught("billing.seller-settings.service.getEffectiveSeller", error);
    throw error;
  }
}

/** For the Invoicing page: what's saved, what env provides, and the effective result. */
export async function getSellerSettingsView(): Promise<{
  saved: SellerSettingsInput | null;
  env: SellerConfig;
  effective: SellerConfig;
  updatedAt: string | null;
  tableReady: boolean;
}> {
  try {
    const { tableReady, row } = await readRow();
    return {
      saved: row
        ? {
            legalName: row.legal_name,
            gstin: row.gstin,
            address: row.address,
            sacCode: row.sac_code,
            invoicePrefix: row.invoice_prefix,
          }
        : null,
      env: loadEnv().seller,
      effective: await getEffectiveSeller(),
      updatedAt: row?.updated_at.toISOString() ?? null,
      tableReady,
    };
  } catch (error: unknown) {
    logCaught("billing.seller-settings.service.getSellerSettingsView", error);
    throw error;
  }
}

/** Upserts the single row and audit-logs the change in the same transaction. Validate before calling. */
export async function saveSellerSettings(input: SellerSettingsInput, adminUserId: string): Promise<void> {
  try {
    await withPoolTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO seller_settings (id, legal_name, gstin, address, sac_code, invoice_prefix, updated_at, updated_by)
         VALUES (true, $1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT (id) DO UPDATE
         SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, address = EXCLUDED.address,
             sac_code = EXCLUDED.sac_code, invoice_prefix = EXCLUDED.invoice_prefix,
             updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [input.legalName, input.gstin, input.address, input.sacCode, input.invoicePrefix, adminUserId]
      );
      await appendAdminAudit(
        {
          adminUserId,
          action: "seller_settings.update",
          targetType: "seller_settings",
          targetId: "seller",
          meta: { ...input },
        },
        client
      );
    });
  } catch (error: unknown) {
    logCaught("billing.seller-settings.service.saveSellerSettings", error);
    throw error;
  }
}

/** How many invoices have been issued in the current financial year (for the prefix-change warning). */
export async function countInvoicesThisFinancialYear(fy: string): Promise<number> {
  try {
    const result: QueryResult<{ last_number: number }> = await getPool().query(
      `SELECT last_number FROM invoice_sequences WHERE financial_year = $1`,
      [fy]
    );
    return result.rows[0]?.last_number ?? 0;
  } catch (error: unknown) {
    logCaught("billing.seller-settings.service.countInvoicesThisFinancialYear", error);
    throw error;
  }
}
