/**
 * Stable credit_ledger.reason values.
 * Never rename — historical rows must keep their meaning.
 */
export const LedgerReason = {
  SIGNUP_GRANT: "signup_grant",
  DEBIT: "debit",
  PURCHASE: "purchase",
  REFUND: "refund",
  REVERSAL: "reversal",
  PROMO: "promo",
  ADMIN_GRANT: "admin_grant",
} as const;

export type LedgerReasonValue = (typeof LedgerReason)[keyof typeof LedgerReason];

export const LedgerReferenceType = {
  SIGNUP: "signup",
  USAGE_EVENT: "usage_event",
} as const;
