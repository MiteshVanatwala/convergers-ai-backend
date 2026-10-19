import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as rulesService from "../auth/email-domain-rules.service";
import {
  DISPOSABLE_LIST_INFO,
  MAINSTREAM_EMAIL_DOMAINS,
  explainSignupEmail,
  invalidateEmailDomainRules,
  normalizeRuleDomain,
} from "../auth/email-policy";

const MAX_NOTE = 500;

/** GET /admin/email-domains — admin rules plus the bundled list's size and date. */
export async function listRules(request: FastifyRequest, reply: FastifyReply) {
  try {
    const rows = await rulesService.listEmailDomainRules();
    return ok(reply, AppStatus.ADMIN_EMAIL_DOMAINS_RETRIEVED, {
      items: rows.map((row) => ({
        domain: row.domain,
        action: row.action,
        note: row.note,
        createdBy: row.created_by_label,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      list: DISPOSABLE_LIST_INFO,
    });
  } catch (error: unknown) {
    logCaught("admin.admin-email-domains.controller.listRules", error);
    request.log.error({ err: error }, "[admin.admin-email-domains.controller.listRules] failed");
    return fail(reply, AppStatus.ADMIN_EMAIL_DOMAINS_FETCH_FAILED, "Failed to load email domain rules", 500);
  }
}

/** PUT /admin/email-domains/:domain { action: block|allow, note? } — add or change a rule. */
export async function saveRule(
  request: FastifyRequest<{ Params: { domain: string }; Body: { action?: string; note?: string | null } }>,
  reply: FastifyReply
) {
  try {
    const domain = normalizeRuleDomain(request.params.domain);
    if (!domain) {
      return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_VALIDATION_FAILED, "Enter a domain like example.com", 400);
    }
    const action = request.body?.action;
    if (action !== "block" && action !== "allow") {
      return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_VALIDATION_FAILED, "action must be block or allow", 400);
    }
    if (action === "block" && MAINSTREAM_EMAIL_DOMAINS.has(domain)) {
      return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_VALIDATION_FAILED, `${domain} is a mainstream provider and can't be blocked`, 400);
    }
    const note = typeof request.body?.note === "string" ? request.body.note.trim().slice(0, MAX_NOTE) || null : null;

    const previousAction = await rulesService.saveEmailDomainRule({ domain, action, note, adminId: request.admin!.id });
    invalidateEmailDomainRules();
    return ok(reply, AppStatus.ADMIN_EMAIL_DOMAIN_SAVED, { domain, action, note, previousAction });
  } catch (error: unknown) {
    logCaught("admin.admin-email-domains.controller.saveRule", error);
    request.log.error({ err: error }, "[admin.admin-email-domains.controller.saveRule] failed");
    return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_SAVE_FAILED, "Failed to save the rule", 500);
  }
}

/** DELETE /admin/email-domains/:domain */
export async function deleteRule(
  request: FastifyRequest<{ Params: { domain: string } }>,
  reply: FastifyReply
) {
  try {
    const domain = normalizeRuleDomain(request.params.domain);
    const deleted = domain ? await rulesService.deleteEmailDomainRule({ domain, adminId: request.admin!.id }) : false;
    if (!deleted) return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_NOT_FOUND, "Rule not found", 404);
    invalidateEmailDomainRules();
    return ok(reply, AppStatus.ADMIN_EMAIL_DOMAIN_DELETED, { domain });
  } catch (error: unknown) {
    logCaught("admin.admin-email-domains.controller.deleteRule", error);
    request.log.error({ err: error }, "[admin.admin-email-domains.controller.deleteRule] failed");
    return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_DELETE_FAILED, "Failed to remove the rule", 500);
  }
}

/** GET /admin/email-domains/check?email= — what sign-up would decide for this address (or bare domain). */
export async function checkEmail(
  request: FastifyRequest<{ Querystring: { email?: string } }>,
  reply: FastifyReply
) {
  try {
    const raw = typeof request.query.email === "string" ? request.query.email.trim() : "";
    if (!raw || raw.length > 254) {
      return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_VALIDATION_FAILED, "Enter an email address or domain", 400);
    }
    const result = await explainSignupEmail(raw.includes("@") ? raw : `x@${raw}`);
    return ok(reply, AppStatus.ADMIN_EMAIL_DOMAIN_CHECKED, result);
  } catch (error: unknown) {
    logCaught("admin.admin-email-domains.controller.checkEmail", error);
    request.log.error({ err: error }, "[admin.admin-email-domains.controller.checkEmail] failed");
    return fail(reply, AppStatus.ADMIN_EMAIL_DOMAIN_CHECK_FAILED, "Failed to check the address", 500);
  }
}
