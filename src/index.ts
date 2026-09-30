import "dotenv/config";
import { billingConfigWarnings, loadEnv } from "./config/env";
import { buildServer } from "./infrastructure/http/server";
import { getEffectiveSeller } from "./modules/billing/seller-settings.service";

const env = loadEnv();

for (const warning of billingConfigWarnings(env)) {
  console.warn(`[config] ${warning}`);
}

buildServer()
  .then((app) => app.listen({ port: env.port, host: "0.0.0.0" }))
  .then(async () => {
    console.log(`backend listening on :${env.port}`);
    // Seller GST details can live in the DB (admin Invoicing page) or env — check the effective values.
    const seller = await getEffectiveSeller().catch(() => null);
    if (seller && (!seller.legalName || !seller.gstin)) {
      console.warn(
        "[config] Seller GST details aren't set: payments won't get GST invoices. " +
          "Add them on the admin panel's Invoicing page (or SELLER_* in backend/.env)."
      );
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
