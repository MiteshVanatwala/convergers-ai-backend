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
