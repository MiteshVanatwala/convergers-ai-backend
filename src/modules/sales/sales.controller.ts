import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { loadEnv } from "../../config/env";
import { isEmailConfigured, sendEmail } from "../../infrastructure/email/send-email";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { consumeRateLimit } from "../../infrastructure/http/rate-limit";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as salesService from "./sales.service";
import { TEAM_SIZE_OPTIONS } from "./sales.service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBMISSIONS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

export type SalesInquiryBody = {
  name?: string;
  email?: string;
  company?: string;
  phone?: string | null;
  teamSize?: string | null;
  message?: string;
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function inquiryEmailText(input: salesService.NewSalesInquiry, accountEmail: string): string {
  return [
    `New sales inquiry from ${input.name} (${input.company})`,
    "",
    `Name:      ${input.name}`,
    `Email:     ${input.email}`,
    `Company:   ${input.company}`,
    `Phone:     ${input.phone ?? "—"}`,
    `Team size: ${input.teamSize ?? "—"}`,
    `Account:   ${accountEmail}`,
    "",
    "Message:",
    input.message,
    "",
    "Reply to this email to reach them. It's also in the admin panel under Sales inquiries.",
  ].join("\n");
}

/** Best-effort: emails the sales inbox when email is configured. Never throws. */
async function emailInquiry(
  request: FastifyRequest,
  id: string,
  input: salesService.NewSalesInquiry,
  accountEmail: string
): Promise<void> {
  if (!isEmailConfigured()) return;
  try {
    await sendEmail({
      to: loadEnv().email.salesInbox,
      subject: `Sales inquiry: ${input.company}`,
      text: inquiryEmailText(input, accountEmail),
      replyTo: input.email,
    });
    await salesService.markSalesInquiryEmailed(id);
  } catch (error: unknown) {
    logCaught("sales.controller.emailInquiry", error);
    request.log.warn({ err: error }, "[sales.controller.emailInquiry] email failed; inquiry saved");
  }
}

/** POST /v1/sales/inquiries — "Contact sales" from the pricing page (signed in). */
export async function createInquiry(
  request: FastifyRequest<{ Body: SalesInquiryBody }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const body = request.body ?? {};
    const name = text(body.name, 120);
    const email = text(body.email, 254)?.toLowerCase() ?? null;
    const company = text(body.company, 200);
    const message = text(body.message, 4000);
    const phone = body.phone == null || body.phone === "" ? null : text(body.phone, 20);
    const teamSize =
      body.teamSize == null || body.teamSize === ""
        ? null
        : (TEAM_SIZE_OPTIONS as readonly string[]).includes(body.teamSize)
          ? body.teamSize
          : undefined;

    if (!name || !company || !message) {
      return fail(
        reply,
        AppStatus.SALES_INQUIRY_VALIDATION_FAILED,
        "Name, company and message are required.",
        400
      );
    }
    if (!email || !EMAIL_RE.test(email)) {
      return fail(reply, AppStatus.SALES_INQUIRY_VALIDATION_FAILED, "Enter a valid email address.", 400);
    }
    if (body.phone && !phone) {
      return fail(reply, AppStatus.SALES_INQUIRY_VALIDATION_FAILED, "Phone number is too long.", 400);
    }
    if (teamSize === undefined) {
      return fail(reply, AppStatus.SALES_INQUIRY_VALIDATION_FAILED, "Pick a team size from the list.", 400);
    }

    const limit = consumeRateLimit(`sales-inquiry:${account.id}`, SUBMISSIONS_PER_HOUR, HOUR_MS);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfterSec));
      return fail(
        reply,
        AppStatus.SALES_INQUIRY_RATE_LIMITED,
        "You've sent several requests recently — we'll get back to you soon.",
        429
      );
    }

    const input: salesService.NewSalesInquiry = {
      accountId: account.id,
      name,
      email,
      company,
      phone,
      teamSize,
      message,
    };
    const { id } = await salesService.createSalesInquiry(input);

    // Saved first, so a failed email never loses the inquiry — the admin inbox still has it.
    await emailInquiry(request, id, input, account.email);

    return ok(reply, AppStatus.SALES_INQUIRY_CREATED, { id }, 201);
  } catch (error: unknown) {
    logCaught("sales.controller.createInquiry", error);
    request.log.error({ err: error }, "[sales.controller.createInquiry] failed");
    return fail(reply, AppStatus.SALES_INQUIRY_FAILED, "Couldn't send your request. Please try again.", 500);
  }
}
