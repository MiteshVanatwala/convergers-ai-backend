import type { FastifyInstance } from "fastify";
import * as billingController from "./billing.controller";

export function registerBillingRoutes(app: FastifyInstance): void {
  app.get("/v1/billing/packages", (request, reply) => billingController.listPackages(request, reply));

  app.get("/v1/billing/summary", (request, reply) => billingController.summary(request, reply));

  app.post<{ Body: { packageId?: string } }>("/v1/billing/credit-purchases", (request, reply) =>
    billingController.createPurchase(request, reply)
  );

  app.post<{ Params: { orderId: string }; Body: { paymentId?: string; signature?: string } }>(
    "/v1/billing/credit-purchases/:orderId/verify",
    (request, reply) => billingController.verifyPurchase(request, reply)
  );

  app.post("/v1/billing/subscriptions", (request, reply) => billingController.createSubscription(request, reply));

  app.post<{ Params: { subscriptionId: string }; Body: { paymentId?: string; signature?: string } }>(
    "/v1/billing/subscriptions/:subscriptionId/verify",
    (request, reply) => billingController.verifySubscription(request, reply)
  );
}

/**
 * Registered as its own encapsulated plugin so the raw-body content-type
 * parser below applies ONLY to this route — every other route in the app
 * (registered outside this plugin scope) keeps Fastify's normal JSON
 * parsing. Razorpay's webhook signature is computed over the exact raw
 * request bytes; re-serializing the parsed JSON before verifying would
 * break it.
 */
export async function registerRazorpayWebhookRoute(app: FastifyInstance): Promise<void> {
  await app.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    instance.post("/webhooks/razorpay", (request, reply) => billingController.handleWebhook(request, reply));
  });
}
