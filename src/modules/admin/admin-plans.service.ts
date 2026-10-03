import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withAdminTransaction } from "../../infrastructure/db/with-admin-transaction";
import { logCaught } from "../../shared/utils/log";
import { asFeatures } from "../plans/plans.service";
import { getHighlightsByPlan } from "../plans/plan-features.service";
import { appendAdminAudit } from "./admin-audit.service";

export type BillingPlanErrorKind = "validation" | "not_found";

export class BillingPlanError extends Error {
  constructor(
    message: string,
    readonly kind: BillingPlanErrorKind
  ) {
    super(message);
    this.name = "BillingPlanError";
  }
}

export type AdminPlanEntry = {
  id: number;
  key: string;
  displayName: string;
  priceUsdCents: number | null;
  includedCredits: number | null;
  rateLimitRpm: number | null;
  tagline: string | null;
  highlights: string[];
  selfServe: boolean;
  recurringGrantCredits: number;
  recurringGrantPeriodHours: number | null;
};

type PlanRow = {
  id: number | string;
  key: string;
  display_name: string;
  price_usd_cents: number | null;
  included_credits: number | null;
  rate_limit_rpm: number | null;
  features: Record<string, unknown> | string;
  recurring_grant_credits: number;
  recurring_grant_period_hours: number | null;
};

/** Only these periods are offered in the admin UI — keeps the "is it due" math a plain timestamp comparison, no calendar edge cases. */
export const RECURRING_GRANT_PERIOD_HOURS = [24, 168, 720] as const;

// Highlights are read-only here — computed from the feature catalog
// (plan_features x feature_catalog, see plan-features.service.ts), not
// stored on the plan row. Admins edit them via the Features tab, not this
// card's form.
function mapPlanRow(row: PlanRow, highlights: string[]): AdminPlanEntry {
  const features = asFeatures(row.features);
  return {
    id: Number(row.id),
    key: row.key,
    displayName: row.display_name,
    priceUsdCents: row.price_usd_cents,
    includedCredits: row.included_credits,
    rateLimitRpm: row.rate_limit_rpm,
    tagline: typeof features.tagline === "string" ? features.tagline : null,
    highlights,
    selfServe: features.self_serve !== false,
    recurringGrantCredits: row.recurring_grant_credits,
    recurringGrantPeriodHours: row.recurring_grant_period_hours,
  };
}

const PLAN_ORDER_SQL = `
  CASE key
    WHEN 'free' THEN 1
    WHEN 'pro' THEN 2
    WHEN 'pay_as_you_go' THEN 3
    WHEN 'enterprise' THEN 4
    ELSE 99
  END, id ASC
`;

export async function listPlansAdmin(): Promise<AdminPlanEntry[]> {
  try {
    const pool = getPool();
    const [result, highlightsByPlan] = await Promise.all([
      pool.query<PlanRow>(
        `SELECT id, key, display_name, price_usd_cents, included_credits, rate_limit_rpm, features,
                recurring_grant_credits, recurring_grant_period_hours
         FROM plans
         ORDER BY ${PLAN_ORDER_SQL}`
      ),
      getHighlightsByPlan(),
    ]);
    return result.rows.map((row) => mapPlanRow(row, highlightsByPlan.get(row.key) ?? []));
  } catch (error: unknown) {
    logCaught("admin.admin-plans.service.listPlansAdmin", error);
    throw error;
  }
}

function nonNegativeIntOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new BillingPlanError(`${field} must be a non-negative integer or null`, "validation");
  }
  return value;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new BillingPlanError(`${field} must be a non-negative integer`, "validation");
  }
  return value;
}

function recurringGrantPeriodHoursOrNull(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !(RECURRING_GRANT_PERIOD_HOURS as readonly number[]).includes(value)
  ) {
    throw new BillingPlanError(
      `recurringGrantPeriodHours must be null or one of ${RECURRING_GRANT_PERIOD_HOURS.join(", ")}`,
      "validation"
    );
  }
  return value;
}

export async function updatePlan(input: {
  actorId: string;
  key: string;
  displayName: string;
  priceUsdCents: number | null;
  includedCredits: number | null;
  rateLimitRpm: number | null;
  tagline: string | null;
  selfServe: boolean;
  recurringGrantCredits: number;
  recurringGrantPeriodHours: number | null;
}): Promise<AdminPlanEntry> {
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new BillingPlanError("displayName is required", "validation");
  }
  const tagline = input.tagline?.trim() || null;
  const priceUsdCents = nonNegativeIntOrNull(input.priceUsdCents, "priceUsdCents");
  const includedCredits = nonNegativeIntOrNull(input.includedCredits, "includedCredits");
  const rateLimitRpm = nonNegativeIntOrNull(input.rateLimitRpm, "rateLimitRpm");
  const recurringGrantCredits = nonNegativeInt(input.recurringGrantCredits, "recurringGrantCredits");
  const recurringGrantPeriodHours = recurringGrantPeriodHoursOrNull(input.recurringGrantPeriodHours);

  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const current = await client.query<PlanRow>(
        `SELECT id, key, display_name, price_usd_cents, included_credits, rate_limit_rpm, features,
                recurring_grant_credits, recurring_grant_period_hours
         FROM plans WHERE key = $1 FOR UPDATE`,
        [input.key]
      );
      const row = current.rows[0];
      if (!row) {
        throw new BillingPlanError("Unknown plan", "not_found");
      }

      // Merge, never overwrite — features carries other keys (e.g. `billing`,
      // `signup_grant`, see db/commercial_plans_v1.sql) that this form
      // doesn't manage and must not silently drop. `highlights` is
      // intentionally absent — it's computed from the feature catalog, not
      // stored here (see plan_features_v1.sql).
      const nextFeatures = {
        ...asFeatures(row.features),
        tagline,
        self_serve: input.selfServe,
      };

      const updated = await client.query<PlanRow>(
        `UPDATE plans
         SET display_name = $2, price_usd_cents = $3, included_credits = $4,
             rate_limit_rpm = $5, features = $6::jsonb,
             recurring_grant_credits = $7, recurring_grant_period_hours = $8
         WHERE key = $1
         RETURNING id, key, display_name, price_usd_cents, included_credits, rate_limit_rpm, features,
                   recurring_grant_credits, recurring_grant_period_hours`,
        [
          input.key,
          displayName,
          priceUsdCents,
          includedCredits,
          rateLimitRpm,
          JSON.stringify(nextFeatures),
          recurringGrantCredits,
          recurringGrantPeriodHours,
        ]
      );

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "billing.update_plan",
          targetType: "plan",
          targetId: input.key,
          meta: {
            displayName,
            priceUsdCents,
            includedCredits,
            rateLimitRpm,
            tagline,
            selfServe: input.selfServe,
            recurringGrantCredits,
            recurringGrantPeriodHours,
          },
        },
        client
      );

      const highlightsByPlan = await getHighlightsByPlan();
      return mapPlanRow(updated.rows[0], highlightsByPlan.get(updated.rows[0].key) ?? []);
    });
  } catch (error: unknown) {
    if (error instanceof BillingPlanError) throw error;
    logCaught("admin.admin-plans.service.updatePlan", error);
    throw error;
  }
}
