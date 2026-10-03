import Razorpay from "razorpay";
import { loadEnv } from "../../config/env";

// Lazy singleton — same convention as infrastructure/db/pool.ts's getPool().
// Razorpay credentials are env-only for this phase (no admin-panel override
// like the LLM provider keys have), so there's no need to reconstruct this
// per call.
let client: Razorpay | null = null;

export function getRazorpayClient(): Razorpay {
  if (client) return client;
  const env = loadEnv();
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new Error(
      "Razorpay isn't configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env"
    );
  }
  client = new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
  return client;
}

export function requireRazorpayKeyId(): string {
  const env = loadEnv();
  if (!env.razorpayKeyId) {
    throw new Error("Razorpay isn't configured — set RAZORPAY_KEY_ID in backend/.env");
  }
  return env.razorpayKeyId;
}

export function requireRazorpayKeySecret(): string {
  const env = loadEnv();
  if (!env.razorpayKeySecret) {
    throw new Error("Razorpay isn't configured — set RAZORPAY_KEY_SECRET in backend/.env");
  }
  return env.razorpayKeySecret;
}

export function requireRazorpayWebhookSecret(): string {
  const env = loadEnv();
  if (!env.razorpayWebhookSecret) {
    throw new Error("Razorpay isn't configured — set RAZORPAY_WEBHOOK_SECRET in backend/.env");
  }
  return env.razorpayWebhookSecret;
}

/** Shown to users when checkout can't start for a reason on our side (keys missing or rejected). */
export const PAYMENTS_UNAVAILABLE_MESSAGE =
  "Payments are temporarily unavailable on our side. Please try again in a little while.";

/**
 * Razorpay keys missing, or rejected by Razorpay (401 "Authentication failed",
 * e.g. after the keys were regenerated in the dashboard). Not the user's fault,
 * and not fixable by retrying — the admin Setup page shows the details.
 */
export function isPaymentsUnavailable(error: unknown): boolean {
  if (error instanceof Error && /Razorpay isn't configured/.test(error.message)) return true;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return statusCode === 401;
}
