import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import {
  financialYearTag,
  formatInvoiceNumber,
  isValidGstin,
  stateName,
} from "../billing/invoices.service";
import * as sellerSettings from "../billing/seller-settings.service";

type Body = {
  legalName?: string | null;
  gstin?: string | null;
  address?: string | null;
  sacCode?: string | null;
  invoicePrefix?: string | null;
};

/** Blank → null (falls back to the env var). */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[ \t]+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

async function view() {
  const settings = await sellerSettings.getSellerSettingsView();
  const fy = financialYearTag(new Date());
  const issuedThisYear = await sellerSettings.countInvoicesThisFinancialYear(fy);
  const gstin = settings.effective.gstin;
  return {
    ...settings,
    sellerStateName: gstin && isValidGstin(gstin) ? stateName(gstin.slice(0, 2)) : null,
    financialYear: fy,
    issuedThisYear,
    nextInvoiceNumber: formatInvoiceNumber(settings.effective.invoicePrefix, fy, issuedThisYear + 1),
  };
}

/** GET /admin/settings/invoicing — seller details (saved, env, effective) + numbering preview. */
export async function getInvoicing(request: FastifyRequest, reply: FastifyReply) {
  try {
    return ok(reply, AppStatus.ADMIN_INVOICING_RETRIEVED, await view());
  } catch (error: unknown) {
    logCaught("admin.invoicing.controller.getInvoicing", error);
    request.log.error({ err: error }, "[admin.invoicing.controller.getInvoicing] failed");
    return fail(reply, AppStatus.ADMIN_INVOICING_FAILED, "Failed to load invoicing settings", 500);
  }
}

/** PUT /admin/settings/invoicing — save seller details; applies to invoices issued from now on. */
export async function saveInvoicing(request: FastifyRequest<{ Body: Body }>, reply: FastifyReply) {
  const admin = request.admin;
  if (!admin) return fail(reply, AppStatus.ADMIN_FORBIDDEN, "Forbidden", 403);
  try {
    const body = request.body ?? {};
    const legalName = clean(body.legalName, 200);
    const gstin = clean(body.gstin, 15)?.toUpperCase().replace(/\s/g, "") ?? null;
    const address = typeof body.address === "string" && body.address.trim() ? body.address.trim().slice(0, 500) : null;
    const sacCode = clean(body.sacCode, 8);
    const invoicePrefix = clean(body.invoicePrefix, 4)?.toUpperCase() ?? null;

    if (gstin && !isValidGstin(gstin)) {
      return fail(reply, AppStatus.ADMIN_INVOICING_VALIDATION_FAILED, "GSTIN should be 15 characters, e.g. 27ABCDE1234F1Z5.", 400);
    }
    if (gstin && !stateName(gstin.slice(0, 2))) {
      return fail(reply, AppStatus.ADMIN_INVOICING_VALIDATION_FAILED, "The GSTIN's state code isn't recognised.", 400);
    }
    if (sacCode && !/^\d{4,8}$/.test(sacCode)) {
      return fail(reply, AppStatus.ADMIN_INVOICING_VALIDATION_FAILED, "SAC code should be 4–8 digits.", 400);
    }
    if (invoicePrefix && !/^[A-Z0-9]{1,4}$/.test(invoicePrefix)) {
      return fail(
        reply,
        AppStatus.ADMIN_INVOICING_VALIDATION_FAILED,
        "Invoice prefix: 1–4 letters or digits (GST limits invoice numbers to 16 characters).",
        400
      );
    }

    await sellerSettings.saveSellerSettings({ legalName, gstin, address, sacCode, invoicePrefix }, admin.id);
    return ok(reply, AppStatus.ADMIN_INVOICING_SAVED, await view());
  } catch (error: unknown) {
    logCaught("admin.invoicing.controller.saveInvoicing", error);
    request.log.error({ err: error }, "[admin.invoicing.controller.saveInvoicing] failed");
    return fail(reply, AppStatus.ADMIN_INVOICING_FAILED, "Failed to save invoicing settings", 500);
  }
}
