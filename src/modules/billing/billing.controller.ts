import type { FastifyReply, FastifyRequest } from "fastify";
import type { QueryResult } from "pg";
// Only validateWebhookSignature is exposed as a static on the Razorpay
// class (confirmed against the compiled SDK) — fine to use that way since
// this is the one the class itself documents.
import Razorpay from "razorpay";
import { AppStatus } from "../../config/app-status-codes";
import { getPool } from "../../infrastructure/db/pool";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import { CREDIT_PACKAGES } from "./credit-packages";
import { requireRazorpayWebhookSecret } from "./razorpay-client";
import * as billingService from "./billing.service";
import * as billingSummaryService from "./billing-summary.service";
import * as invoicesService from "./invoices.service";
import { renderInvoiceHtml } from "./invoice-html";
import { getMembership } from "../orgs/orgs.service";
import { canManageOrg } from "../orgs/orgs.permissions";
import { BillingError } from "./billing.service";
import * as subscriptionService from "./subscription.service";
import * as autoTopUpService from "./auto-topup.service";
import { SubscriptionError } from "./subscription.service";

function failFromBillingError(reply: FastifyReply, error: BillingError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, error.message, 400);
    case "not_found":
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, error.message, 404);
  }
}

function failFromSubscriptionError(reply: FastifyReply, error: SubscriptionError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.BILLING_SUBSCRIPTION_VALIDATION_FAILED, error.message, 400);
    case "not_found":
      return fail(reply, AppStatus.BILLING_SUBSCRIPTION_VALIDATION_FAILED, error.message, 404);
  }
}

export async function listPackages(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  return ok(reply, AppStatus.BILLING_PACKAGES_RETRIEVED, CREDIT_PACKAGES);
}

export async function summary(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const data = await billingSummaryService.getBillingSummary(account.id);
    return ok(reply, AppStatus.BILLING_SUMMARY_RETRIEVED, data);
  } catch (error: unknown) {
    logCaught("billing.controller.summary", error);
    request.log.error({ err: error }, "[billing.controller.summary] failed");
    return fail(reply, AppStatus.BILLING_SUMMARY_FETCH_FAILED, "Failed to load billing details", 500);
  }
}

export async function createPurchase(
  request: FastifyRequest<{ Body: { packageId?: string; target?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const packageId = typeof request.body?.packageId === "string" ? request.body.packageId : "";
    if (!packageId) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, "packageId is required", 400);
    }

    // target "org": top up the caller's organization pool — admins only.
    let orgId: string | null = null;
    if (request.body?.target === "org") {
      const membership = await getMembership(account.id);
      if (!membership) {
        return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, "You're not in an organization.", 400);
      }
      if (!canManageOrg(membership.role)) {
        return fail(reply, AppStatus.ORG_FORBIDDEN, "Only organization admins can add shared credits.", 403);
      }
      orgId = membership.orgId;
    }

    const result = await billingService.createPurchaseOrder({ accountId: account.id, packageId, orgId });
    return ok(reply, AppStatus.BILLING_PURCHASE_CREATED, result);
  } catch (error: unknown) {
    if (error instanceof BillingError) return failFromBillingError(reply, error);
    logCaught("billing.controller.createPurchase", error);
    return fail(reply, AppStatus.BILLING_PURCHASE_CREATE_FAILED, "Failed to start purchase", 500);
  }
}

export async function verifyPurchase(
  request: FastifyRequest<{
    Params: { orderId: string };
    Body: { paymentId?: string; signature?: string };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const { orderId } = request.params;
    const paymentId = typeof request.body?.paymentId === "string" ? request.body.paymentId : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    if (!paymentId || !signature) {
      return fail(
        reply,
        AppStatus.BILLING_PURCHASE_VALIDATION_FAILED,
        "paymentId and signature are required",
        400
      );
    }

    const pool = getPool();
    const owned: QueryResult<{ account_id: string }> = await pool.query(
      `SELECT account_id FROM credit_purchases WHERE razorpay_order_id = $1`,
      [orderId]
    );
    if (owned.rows[0]?.account_id !== account.id) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, "Purchase not found", 404);
    }

    const validSignature = billingService.verifyOrderPaymentSignature({ orderId, paymentId, signature });
    if (!validSignature) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VERIFY_FAILED, "Invalid payment signature", 400);
    }

    await billingService.finalizeCreditPurchase({ razorpayOrderId: orderId, razorpayPaymentId: paymentId });
    return ok(reply, AppStatus.BILLING_PURCHASE_VERIFIED, { ok: true });
  } catch (error: unknown) {
    logCaught("billing.controller.verifyPurchase", error);
    return fail(reply, AppStatus.BILLING_PURCHASE_VERIFY_FAILED, "Failed to verify purchase", 500);
  }
}

export async function createSubscription(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const result = await subscriptionService.createProSubscription(account.id);
    return ok(reply, AppStatus.BILLING_SUBSCRIPTION_CREATED, result);
  } catch (error: unknown) {
    if (error instanceof SubscriptionError) return failFromSubscriptionError(reply, error);
    logCaught("billing.controller.createSubscription", error);
    return fail(reply, AppStatus.BILLING_SUBSCRIPTION_CREATE_FAILED, "Failed to start subscription", 500);
  }
}

export async function verifySubscription(
  request: FastifyRequest<{
    Params: { subscriptionId: string };
    Body: { paymentId?: string; signature?: string };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const { subscriptionId } = request.params;
    const paymentId = typeof request.body?.paymentId === "string" ? request.body.paymentId : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    if (!paymentId || !signature) {
      return fail(
        reply,
        AppStatus.BILLING_SUBSCRIPTION_VALIDATION_FAILED,
        "paymentId and signature are required",
        400
      );
    }

    const pool = getPool();
    const owned: QueryResult<{ account_id: string | null; org_id: string | null }> = await pool.query(
      `SELECT account_id, org_id::text AS org_id FROM subscriptions WHERE razorpay_subscription_id = $1`,
      [subscriptionId]
    );
    const sub = owned.rows[0];
    // Pro subscriptions belong to an account; Team subscriptions to an org its admins manage.
    let mayVerify = sub?.account_id === account.id;
    if (!mayVerify && sub?.org_id) {
      const membership = await getMembership(account.id);
      mayVerify = membership?.orgId === sub.org_id && canManageOrg(membership.role);
    }
    if (!mayVerify) {
      return fail(reply, AppStatus.BILLING_SUBSCRIPTION_VALIDATION_FAILED, "Subscription not found", 404);
    }

    const validSignature = subscriptionService.verifySubscriptionPaymentSignature({
      subscriptionId,
      paymentId,
      signature,
    });
    if (!validSignature) {
      return fail(reply, AppStatus.BILLING_SUBSCRIPTION_VERIFY_FAILED, "Invalid payment signature", 400);
    }

    await subscriptionService.finalizeSubscriptionActivation({ razorpaySubscriptionId: subscriptionId });
    // First month's credits; renewals arrive via the subscription.charged webhook.
    await subscriptionService.grantSubscriptionCredits({
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: paymentId,
    });
    return ok(reply, AppStatus.BILLING_SUBSCRIPTION_VERIFIED, { ok: true });
  } catch (error: unknown) {
    logCaught("billing.controller.verifySubscription", error);
    return fail(reply, AppStatus.BILLING_SUBSCRIPTION_VERIFY_FAILED, "Failed to verify subscription", 500);
  }
}

type RazorpayWebhookPayload = {
  event?: string;
  payload?: {
    payment?: {
      entity?: { id?: string; order_id?: string; error_description?: string };
    };
    order?: {
      entity?: { id?: string };
    };
    subscription?: {
      entity?: { id?: string; status?: string; quantity?: number };
    };
  };
};

/**
 * No session — Razorpay is the caller, authenticated by its own signature
 * instead. Requires the raw request body (see billing.routes.ts's scoped
 * content-type parser); replies 200/400 directly rather than through the
 * usual ok()/fail() envelope, matching how the other non-browser-facing
 * routes in this codebase behave.
 */
export async function handleWebhook(request: FastifyRequest, reply: FastifyReply) {
  // A missing secret is a config problem, not a bad event: answer 503 so
  // Razorpay keeps retrying (for up to ~24h) until it's fixed. The catch-all
  // 200 below would make Razorpay treat the event as delivered and drop it.
  let webhookSecret: string;
  try {
    webhookSecret = requireRazorpayWebhookSecret();
  } catch {
    request.log.error("[billing.controller.handleWebhook] RAZORPAY_WEBHOOK_SECRET is not set");
    return reply.status(503).send({ error: "webhook secret not configured" });
  }

  try {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.status(400).send({ error: "expected raw body" });
    }
    const signature = request.headers["x-razorpay-signature"];
    if (typeof signature !== "string") {
      return reply.status(400).send({ error: "missing signature" });
    }

    const bodyString = rawBody.toString("utf8");
    const valid = Razorpay.validateWebhookSignature(bodyString, signature, webhookSecret);
    if (!valid) {
      return reply.status(400).send({ error: "invalid signature" });
    }

    const payload = JSON.parse(bodyString) as RazorpayWebhookPayload;
    const eventType = payload.event ?? "";
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const subscriptionEntity = payload.payload?.subscription?.entity;

    if (eventType === "payment.captured" && paymentEntity?.id && paymentEntity.order_id) {
      await billingService.finalizeCreditPurchase({
        razorpayOrderId: paymentEntity.order_id,
        razorpayPaymentId: paymentEntity.id,
      });
      // No-op unless this was a Pay-as-you-go setup payment (saves the card token).
      await autoTopUpService.completeAutoTopUpSetup({
        razorpayOrderId: paymentEntity.order_id,
        razorpayPaymentId: paymentEntity.id,
      });
    } else if (eventType === "order.paid" && orderEntity?.id && paymentEntity?.id) {
      await billingService.finalizeCreditPurchase({
        razorpayOrderId: orderEntity.id,
        razorpayPaymentId: paymentEntity.id,
      });
      await autoTopUpService.completeAutoTopUpSetup({
        razorpayOrderId: orderEntity.id,
        razorpayPaymentId: paymentEntity.id,
      });
    } else if (eventType === "payment.failed" && paymentEntity?.order_id) {
      // Only automatic charges are tracked here; a failed Checkout attempt can simply be retried.
      await autoTopUpService.markAutoTopUpFailed(
        paymentEntity.order_id,
        paymentEntity.error_description || "The payment was declined."
      );
    } else if (
      (eventType === "subscription.activated" || eventType === "subscription.charged") &&
      subscriptionEntity?.id
    ) {
      await subscriptionService.finalizeSubscriptionActivation({
        razorpaySubscriptionId: subscriptionEntity.id,
      });
      // Every successful charge (first month and each renewal) grants the
      // plan's included credits — idempotent per payment id.
      if (eventType === "subscription.charged" && paymentEntity?.id) {
        // A seat decrease scheduled for cycle end arrives here as the new quantity —
        // sync it first so this charge grants credits for the seats actually billed.
        if (typeof subscriptionEntity.quantity === "number") {
          await subscriptionService.syncSubscriptionQuantity({
            razorpaySubscriptionId: subscriptionEntity.id,
            quantity: subscriptionEntity.quantity,
          });
        }
        await subscriptionService.grantSubscriptionCredits({
          razorpaySubscriptionId: subscriptionEntity.id,
          razorpayPaymentId: paymentEntity.id,
        });
      }
    } else if (
      (eventType === "subscription.cancelled" ||
        eventType === "subscription.completed" ||
        eventType === "subscription.halted") &&
      subscriptionEntity?.id
    ) {
      const status =
        eventType === "subscription.cancelled"
          ? "cancelled"
          : eventType === "subscription.completed"
            ? "completed"
            : "halted";
      await subscriptionService.handleSubscriptionCancelled({
        razorpaySubscriptionId: subscriptionEntity.id,
        status,
      });
    }
    // Other event types (refunds, disputes) are out of scope for this phase —
    // acknowledged with 200 so Razorpay doesn't retry them.

    return reply.status(200).send({ ok: true });
  } catch (error: unknown) {
    logCaught("billing.controller.handleWebhook", error);
    // 200, not 500: a bug on our side shouldn't make Razorpay retry
    // indefinitely for an event we may already be failing to process for a
    // structural reason. Errors are still logged above for investigation.
    return reply.status(200).send({ ok: false });
  }
}

// ---------------------------------------------------------------------------
// Pay-as-you-go auto top-up (personal wallet)
// ---------------------------------------------------------------------------

function failFromAutoTopUpError(reply: FastifyReply, error: BillingError) {
  return fail(
    reply,
    AppStatus.BILLING_AUTO_TOPUP_VALIDATION_FAILED,
    error.message,
    error.kind === "not_found" ? 404 : 400
  );
}

/** GET /v1/billing/auto-topup — the caller's auto top-up settings (null if never set up). */
export async function getAutoTopUp(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    return ok(reply, AppStatus.BILLING_AUTO_TOPUP_RETRIEVED, await autoTopUpService.getAutoTopUp(account.id));
  } catch (error: unknown) {
    logCaught("billing.controller.getAutoTopUp", error);
    return fail(reply, AppStatus.BILLING_AUTO_TOPUP_FAILED, "Failed to load pay-as-you-go settings", 500);
  }
}

/** POST /v1/billing/auto-topup/setup — first pack purchase that also saves the card. */
export async function setupAutoTopUp(
  request: FastifyRequest<{ Body: { packageId?: string; thresholdCredits?: number; contact?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    if (await getMembership(account.id)) {
      return fail(
        reply,
        AppStatus.BILLING_AUTO_TOPUP_VALIDATION_FAILED,
        "Your requests use your organization's shared credits, so pay-as-you-go isn't needed.",
        400
      );
    }
    const result = await autoTopUpService.startAutoTopUpSetup({
      accountId: account.id,
      email: account.email,
      name: account.name ?? null,
      packageId: typeof request.body?.packageId === "string" ? request.body.packageId : "",
      thresholdCredits: Number(request.body?.thresholdCredits),
      contact: typeof request.body?.contact === "string" ? request.body.contact : "",
    });
    return ok(reply, AppStatus.BILLING_PURCHASE_CREATED, result);
  } catch (error: unknown) {
    if (error instanceof BillingError) return failFromAutoTopUpError(reply, error);
    logCaught("billing.controller.setupAutoTopUp", error);
    return fail(reply, AppStatus.BILLING_AUTO_TOPUP_FAILED, "Failed to start pay-as-you-go setup", 500);
  }
}

/** POST /v1/billing/auto-topup/setup/:orderId/verify — Checkout success: credit the pack and save the card. */
export async function verifyAutoTopUpSetup(
  request: FastifyRequest<{ Params: { orderId: string }; Body: { paymentId?: string; signature?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const { orderId } = request.params;
    const paymentId = typeof request.body?.paymentId === "string" ? request.body.paymentId : "";
    const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
    if (!paymentId || !signature) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, "paymentId and signature are required", 400);
    }
    const owned: QueryResult<{ account_id: string }> = await getPool().query(
      `SELECT account_id FROM credit_purchases WHERE razorpay_order_id = $1 AND source = 'auto_topup_setup'`,
      [orderId]
    );
    if (owned.rows[0]?.account_id !== account.id) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, "Purchase not found", 404);
    }
    if (!billingService.verifyOrderPaymentSignature({ orderId, paymentId, signature })) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VERIFY_FAILED, "Invalid payment signature", 400);
    }
    await billingService.finalizeCreditPurchase({ razorpayOrderId: orderId, razorpayPaymentId: paymentId });
    await autoTopUpService.completeAutoTopUpSetup({ razorpayOrderId: orderId, razorpayPaymentId: paymentId });
    return ok(reply, AppStatus.BILLING_AUTO_TOPUP_SAVED, await autoTopUpService.getAutoTopUp(account.id));
  } catch (error: unknown) {
    logCaught("billing.controller.verifyAutoTopUpSetup", error);
    return fail(reply, AppStatus.BILLING_PURCHASE_VERIFY_FAILED, "Failed to verify payment", 500);
  }
}

/** PATCH /v1/billing/auto-topup — change pack / threshold, pause or resume. */
export async function updateAutoTopUp(
  request: FastifyRequest<{ Body: { packageId?: string; thresholdCredits?: number; enabled?: boolean } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const body = request.body ?? {};
    const view = await autoTopUpService.updateAutoTopUp(account.id, {
      packageId: typeof body.packageId === "string" ? body.packageId : undefined,
      thresholdCredits: body.thresholdCredits === undefined ? undefined : Number(body.thresholdCredits),
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    return ok(reply, AppStatus.BILLING_AUTO_TOPUP_SAVED, view);
  } catch (error: unknown) {
    if (error instanceof BillingError) return failFromAutoTopUpError(reply, error);
    logCaught("billing.controller.updateAutoTopUp", error);
    return fail(reply, AppStatus.BILLING_AUTO_TOPUP_FAILED, "Failed to update pay-as-you-go", 500);
  }
}

/** DELETE /v1/billing/auto-topup — turn off and forget the saved card. */
export async function removeAutoTopUp(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    await autoTopUpService.removeAutoTopUp(account.id);
    return ok(reply, AppStatus.BILLING_AUTO_TOPUP_SAVED, null);
  } catch (error: unknown) {
    logCaught("billing.controller.removeAutoTopUp", error);
    return fail(reply, AppStatus.BILLING_AUTO_TOPUP_FAILED, "Failed to remove saved card", 500);
  }
}

// ---------------------------------------------------------------------------
// GST invoices & billing details
// ---------------------------------------------------------------------------

type ProfileTarget = { target?: string };

/**
 * Whose billing details a request is about: the caller's own, or (target=org)
 * their organization's — which only its admins may view or change.
 */
async function resolveProfileOwner(
  accountId: string,
  target: string | undefined,
  reply: FastifyReply
): Promise<{ accountId: string } | { orgId: string } | null> {
  if (target !== "org") return { accountId };
  const membership = await getMembership(accountId);
  if (!membership) {
    fail(reply, AppStatus.BILLING_PROFILE_VALIDATION_FAILED, "You're not in an organization.", 400);
    return null;
  }
  if (!canManageOrg(membership.role)) {
    fail(reply, AppStatus.ORG_FORBIDDEN, "Only organization admins can manage its billing details.", 403);
    return null;
  }
  return { orgId: membership.orgId };
}

/** GET /v1/billing/profile?target=org — buyer details printed on invoices (null if none saved). */
export async function getProfile(
  request: FastifyRequest<{ Querystring: ProfileTarget }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const owner = await resolveProfileOwner(account.id, request.query?.target, reply);
    if (!owner) return;
    const profile = await invoicesService.getBillingProfile(owner);
    return ok(reply, AppStatus.BILLING_PROFILE_RETRIEVED, { profile });
  } catch (error: unknown) {
    logCaught("billing.controller.getProfile", error);
    request.log.error({ err: error }, "[billing.controller.getProfile] failed");
    return fail(reply, AppStatus.BILLING_PROFILE_FAILED, "Failed to load billing details", 500);
  }
}

/** PUT /v1/billing/profile — save buyer details; applies to invoices issued from now on. */
export async function saveProfile(
  request: FastifyRequest<{
    Body: ProfileTarget & {
      legalName?: string;
      gstin?: string | null;
      address?: string | null;
      city?: string | null;
      postalCode?: string | null;
      stateCode?: string | null;
    };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const body = request.body ?? {};
    const owner = await resolveProfileOwner(account.id, body.target, reply);
    if (!owner) return;

    const legalName = typeof body.legalName === "string" ? body.legalName.replace(/\s+/g, " ").trim() : "";
    if (!legalName || legalName.length > 200) {
      return fail(reply, AppStatus.BILLING_PROFILE_VALIDATION_FAILED, "Legal name is required (up to 200 characters).", 400);
    }
    const gstin = typeof body.gstin === "string" && body.gstin.trim() ? body.gstin.trim().toUpperCase() : null;
    if (gstin && !invoicesService.isValidGstin(gstin)) {
      return fail(reply, AppStatus.BILLING_PROFILE_VALIDATION_FAILED, "That GSTIN doesn't look right — it should be 15 characters, e.g. 27ABCDE1234F1Z5.", 400);
    }
    const address = typeof body.address === "string" && body.address.trim() ? body.address.trim().slice(0, 500) : null;
    const city = typeof body.city === "string" && body.city.trim() ? body.city.trim().slice(0, 100) : null;
    const postalCode =
      typeof body.postalCode === "string" && body.postalCode.trim() ? body.postalCode.replace(/\s/g, "") : null;
    if (postalCode && !/^[1-9]\d{5}$/.test(postalCode)) {
      return fail(reply, AppStatus.BILLING_PROFILE_VALIDATION_FAILED, "PIN code should be 6 digits.", 400);
    }
    const stateCode = typeof body.stateCode === "string" && body.stateCode ? body.stateCode : null;
    if (stateCode && !invoicesService.stateName(stateCode)) {
      return fail(reply, AppStatus.BILLING_PROFILE_VALIDATION_FAILED, "Unknown state.", 400);
    }
    if (gstin && !invoicesService.stateName(gstin.slice(0, 2))) {
      return fail(reply, AppStatus.BILLING_PROFILE_VALIDATION_FAILED, "The GSTIN's state code isn't recognised.", 400);
    }

    const profile = await invoicesService.saveBillingProfile(owner, {
      legalName,
      gstin,
      address,
      city,
      postalCode,
      stateCode,
    });
    return ok(reply, AppStatus.BILLING_PROFILE_SAVED, { profile });
  } catch (error: unknown) {
    logCaught("billing.controller.saveProfile", error);
    request.log.error({ err: error }, "[billing.controller.saveProfile] failed");
    return fail(reply, AppStatus.BILLING_PROFILE_FAILED, "Failed to save billing details", 500);
  }
}

/** GET /v1/billing/invoices — the caller's invoices, plus their org's if they're an org admin. */
export async function listInvoices(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const membership = await getMembership(account.id);
    const adminOrgId = membership && canManageOrg(membership.role) ? membership.orgId : null;
    const rows = await invoicesService.listInvoices(account.id, adminOrgId);
    return ok(reply, AppStatus.BILLING_INVOICES_RETRIEVED, {
      items: rows.map((row) => ({
        id: row.id,
        invoiceNumber: row.invoice_number,
        issuedAt: row.issued_at.toISOString(),
        description: row.description,
        totalPaise: row.total_paise,
        scope: row.org_id ? "org" : "personal",
      })),
    });
  } catch (error: unknown) {
    logCaught("billing.controller.listInvoices", error);
    request.log.error({ err: error }, "[billing.controller.listInvoices] failed");
    return fail(reply, AppStatus.BILLING_INVOICES_FAILED, "Failed to load invoices", 500);
  }
}

/** GET /v1/billing/invoices/:id/html — printable tax invoice (payer, or admins of the paying org). */
export async function invoiceHtml(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const invoice = /^[0-9a-f-]{36}$/i.test(request.params.id)
      ? await invoicesService.getInvoice(request.params.id)
      : null;
    let allowed = invoice !== null && invoice.org_id === null && invoice.account_id === account.id;
    if (invoice?.org_id) {
      const membership = await getMembership(account.id);
      allowed = membership?.orgId === invoice.org_id && canManageOrg(membership.role);
    }
    if (!invoice || !allowed) {
      return fail(reply, AppStatus.BILLING_INVOICE_NOT_FOUND, "Invoice not found", 404);
    }
    return reply
      .status(200)
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "private, no-store")
      .send(renderInvoiceHtml(invoice));
  } catch (error: unknown) {
    logCaught("billing.controller.invoiceHtml", error);
    request.log.error({ err: error }, "[billing.controller.invoiceHtml] failed");
    return fail(reply, AppStatus.BILLING_INVOICES_FAILED, "Failed to load invoice", 500);
  }
}
