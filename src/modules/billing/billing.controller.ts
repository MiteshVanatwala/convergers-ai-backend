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
import { BillingError } from "./billing.service";
import * as subscriptionService from "./subscription.service";
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
  request: FastifyRequest<{ Body: { packageId?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const packageId = typeof request.body?.packageId === "string" ? request.body.packageId : "";
    if (!packageId) {
      return fail(reply, AppStatus.BILLING_PURCHASE_VALIDATION_FAILED, "packageId is required", 400);
    }
    const result = await billingService.createPurchaseOrder({ accountId: account.id, packageId });
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
    const owned: QueryResult<{ account_id: string }> = await pool.query(
      `SELECT account_id FROM subscriptions WHERE razorpay_subscription_id = $1`,
      [subscriptionId]
    );
    if (owned.rows[0]?.account_id !== account.id) {
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
      entity?: { id?: string; order_id?: string };
    };
    order?: {
      entity?: { id?: string };
    };
    subscription?: {
      entity?: { id?: string; status?: string };
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
    const valid = Razorpay.validateWebhookSignature(bodyString, signature, requireRazorpayWebhookSecret());
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
    } else if (eventType === "order.paid" && orderEntity?.id && paymentEntity?.id) {
      await billingService.finalizeCreditPurchase({
        razorpayOrderId: orderEntity.id,
        razorpayPaymentId: paymentEntity.id,
      });
    } else if (
      (eventType === "subscription.activated" || eventType === "subscription.charged") &&
      subscriptionEntity?.id
    ) {
      await subscriptionService.finalizeSubscriptionActivation({
        razorpaySubscriptionId: subscriptionEntity.id,
      });
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
