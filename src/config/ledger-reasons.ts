/**
 * Stable credit_ledger.reason values.
 * Never rename — historical rows must keep their meaning.
 */
export const LedgerReason = {
  SIGNUP_GRANT: "signup_grant",
  RECURRING_GRANT: "recurring_grant",
  DEBIT: "debit",
  PURCHASE: "purchase",
  REFUND: "refund",
  REVERSAL: "reversal",
  PROMO: "promo",
  ADMIN_GRANT: "admin_grant",
  /** A paid subscription's included credits, granted on each successful charge. */
  SUBSCRIPTION_GRANT: "subscription_grant",
} as const;

export type LedgerReasonValue = (typeof LedgerReason)[keyof typeof LedgerReason];

export const LedgerReferenceType = {
  SIGNUP: "signup",
  RECURRING_GRANT: "recurring_grant",
  USAGE_EVENT: "usage_event",
  CREDIT_PURCHASE: "credit_purchase",
  /** reference_id = Razorpay payment id of the subscription charge. */
  SUBSCRIPTION_PAYMENT: "subscription_payment",
} as const;
