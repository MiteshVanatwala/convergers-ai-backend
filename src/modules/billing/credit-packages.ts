// Fixed package list for Phase 1 — not admin-editable yet (see the payment
// gateway plan's "explicitly out of scope" section). An admin-configurable
// table mirroring the Plans page pattern is the natural follow-up once the
// core purchase flow is proven.
export type CreditPackage = {
  id: string;
  label: string;
  amountInrPaise: number;
  /** Price for buyers billed outside India (USD, no GST — export under LUT). */
  amountUsdCents: number;
  credits: number;
};

// 1,000 credits = $1 of provider cost (ledger CREDITS_PER_USD). Sized so each
// pack sells above cost after GST and gateway fees — the previous 6,000 /
// 13,000-credit packs sold credits below cost.
// USD prices are international list prices, not a conversion of the INR ones.
export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "starter", label: "₹99 — 700 credits", amountInrPaise: 9_900, amountUsdCents: 299, credits: 700 },
  { id: "plus", label: "₹499 — 3,500 credits", amountInrPaise: 49_900, amountUsdCents: 999, credits: 3_500 },
  { id: "pro", label: "₹999 — 7,500 credits", amountInrPaise: 99_900, amountUsdCents: 1_999, credits: 7_500 },
];

/** "$9.99 — 3,500 credits" for USD buyers; the INR label as is. */
export function packageLabel(pkg: CreditPackage, currency: "INR" | "USD"): string {
  if (currency === "INR") return pkg.label;
  return `$${(pkg.amountUsdCents / 100).toFixed(2)} — ${pkg.credits.toLocaleString("en-US")} credits`;
}

/** A pack's price in the buyer's currency, in that currency's minor unit (paise / cents). */
export function packageAmount(pkg: CreditPackage, currency: "INR" | "USD"): number {
  return currency === "USD" ? pkg.amountUsdCents : pkg.amountInrPaise;
}

export function findCreditPackage(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}
