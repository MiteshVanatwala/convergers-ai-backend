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

export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "starter", label: "₹99 — 1,000 credits", amountInrPaise: 9_900, credits: 1_000 },
  { id: "plus", label: "₹499 — 6,000 credits", amountInrPaise: 49_900, credits: 6_000 },
  { id: "pro", label: "₹999 — 13,000 credits", amountInrPaise: 99_900, credits: 13_000 },
];

export function findCreditPackage(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}
