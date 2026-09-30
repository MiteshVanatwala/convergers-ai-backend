// Fixed package list for Phase 1 — not admin-editable yet (see the payment
// gateway plan's "explicitly out of scope" section). An admin-configurable
// table mirroring the Plans page pattern is the natural follow-up once the
// core purchase flow is proven.
export type CreditPackage = {
  id: string;
  label: string;
  amountInrPaise: number;
  credits: number;
};

// 1,000 credits = $1 of provider cost (ledger CREDITS_PER_USD). Sized so each
// pack sells above cost after GST and gateway fees — the previous 6,000 /
// 13,000-credit packs sold credits below cost.
export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "starter", label: "₹99 — 700 credits", amountInrPaise: 9_900, credits: 700 },
  { id: "plus", label: "₹499 — 3,500 credits", amountInrPaise: 49_900, credits: 3_500 },
  { id: "pro", label: "₹999 — 7,500 credits", amountInrPaise: 99_900, credits: 7_500 },
];

export function findCreditPackage(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}
