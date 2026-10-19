import { COUNTRY_CODES, currencyForCountry, type BillingCurrency } from "@convergers-ai/shared-types";

export { currencyForCountry, type BillingCurrency };

export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && COUNTRY_CODES.includes(value);
}

/** English country name for invoices ("United States"); the code itself if unknown. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
