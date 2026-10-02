import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as salesService from "../sales/sales.service";
import type { SalesInquiryStatus } from "../sales/sales.service";

const MAX_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseStatus(raw: unknown): SalesInquiryStatus | null | undefined {
  if (raw === undefined || raw === "" || raw === "all") return null;
  if (raw === "new" || raw === "handled") return raw;
  return undefined;
}

/** GET /admin/sales-inquiries?status=new|handled|all&limit&offset */
export async function listInquiries(
  request: FastifyRequest<{ Querystring: { status?: string; limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  try {
    const status = parseStatus(request.query.status);
    if (status === undefined) {
      return fail(reply, AppStatus.ADMIN_SALES_INQUIRY_VALIDATION_FAILED, "status must be new, handled or all", 400);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.query.limit) || 50));
    const offset = Math.max(0, Number(request.query.offset) || 0);
    const result = await salesService.listSalesInquiries({ status, limit, offset });
    return ok(reply, AppStatus.ADMIN_SALES_INQUIRIES_RETRIEVED, {
      items: result.items.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        name: row.name,
        email: row.email,
        company: row.company,
        phone: row.phone,
        teamSize: row.team_size,
        message: row.message,
        status: row.status,
        handledBy: row.handled_by_label,
        handledAt: row.handled_at?.toISOString() ?? null,
        emailSentAt: row.email_sent_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
      total: result.total,
      newCount: result.newCount,
    });
  } catch (error: unknown) {
    logCaught("admin.admin-sales.controller.listInquiries", error);
    return fail(reply, AppStatus.ADMIN_SALES_INQUIRIES_FETCH_FAILED, "Failed to load sales inquiries", 500);
  }
}

/** PATCH /admin/sales-inquiries/:id { status } — mark handled, or reopen. */
export async function updateInquiry(
  request: FastifyRequest<{ Params: { id: string }; Body: { status?: string } }>,
  reply: FastifyReply
) {
  try {
    if (!UUID_RE.test(request.params.id)) {
      return fail(reply, AppStatus.ADMIN_SALES_INQUIRY_NOT_FOUND, "Inquiry not found", 404);
    }
    const status = request.body?.status;
    if (status !== "new" && status !== "handled") {
      return fail(reply, AppStatus.ADMIN_SALES_INQUIRY_VALIDATION_FAILED, "status must be new or handled", 400);
    }
    const found = await salesService.setSalesInquiryStatus({
      id: request.params.id,
      status,
      adminId: request.admin!.id,
    });
    if (!found) return fail(reply, AppStatus.ADMIN_SALES_INQUIRY_NOT_FOUND, "Inquiry not found", 404);
    return ok(reply, AppStatus.ADMIN_SALES_INQUIRY_UPDATED, { id: request.params.id, status });
  } catch (error: unknown) {
    logCaught("admin.admin-sales.controller.updateInquiry", error);
    return fail(reply, AppStatus.ADMIN_SALES_INQUIRY_UPDATE_FAILED, "Failed to update inquiry", 500);
  }
}
