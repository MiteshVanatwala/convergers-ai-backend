import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export const PLAN_KEY_ORDER = ["free", "pro", "pay_as_you_go", "enterprise"] as const;
export type PlanKey = (typeof PLAN_KEY_ORDER)[number];

export type PlanCatalogRow = {
  id: number;
  key: string;
  display_name: string;
  price_usd_cents: number | null;
  included_credits: number | null;
  rate_limit_rpm: number | null;
  features: Record<string, unknown>;
};

export type ActivePlanMembership = {
  membershipId: string;
  planId: number;
  key: string;
  displayName: string;
  priceUsdCents: number | null;
  includedCredits: number | null;
  rateLimitRpm: number | null;
  features: Record<string, unknown>;
  startedAt: Date;
  endsAt: Date | null;
};

type Queryable = PoolClient | ReturnType<typeof getPool>;

type MembershipJoinRow = {
  membership_id: string;
  plan_id: string | number;
  key: string;
  display_name: string;
  price_usd_cents: number | null;
  included_credits: number | null;
  rate_limit_rpm: number | null;
  features: Record<string, unknown> | string;
  started_at: Date;
  ends_at: Date | null;
};

function asFeatures(raw: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return raw;
}

function mapMembership(row: MembershipJoinRow): ActivePlanMembership {
  return {
    membershipId: row.membership_id,
    planId: Number(row.plan_id),
    key: row.key,
    displayName: row.display_name,
    priceUsdCents: row.price_usd_cents,
    includedCredits: row.included_credits,
    rateLimitRpm: row.rate_limit_rpm,
    features: asFeatures(row.features),
    startedAt: row.started_at,
    endsAt: row.ends_at,
  };
}

const ACTIVE_PLAN_SQL = `
  SELECT
    ap.id AS membership_id,
    ap.plan_id,
    p.key,
    p.display_name,
    p.price_usd_cents,
    p.included_credits,
    p.rate_limit_rpm,
    p.features,
    ap.started_at,
    ap.ends_at
  FROM account_plans ap
  JOIN plans p ON p.id = ap.plan_id
  WHERE ap.account_id = $1
    AND ap.status = 'active'
  LIMIT 1
`;

export async function getActivePlan(
  accountId: string,
  client?: PoolClient
): Promise<ActivePlanMembership | null> {
  try {
    const db: Queryable = client ?? getPool();
    const result: QueryResult<MembershipJoinRow> = await db.query<MembershipJoinRow>(ACTIVE_PLAN_SQL, [
      accountId,
    ]);
    const row = result.rows[0];
    return row ? mapMembership(row) : null;
  } catch (error: unknown) {
    logCaught("plans.service.getActivePlan", error);
    throw error;
  }
}

/**
 * Ensure the account has an active Free membership.
 * Idempotent — safe on signup and as a repair path for older accounts.
 */
export async function ensureFreePlanMembership(
  accountId: string,
  client?: PoolClient,
  source: "signup" | "migration" = "signup"
): Promise<ActivePlanMembership> {
  try {
    const db: Queryable = client ?? getPool();
    const existing = await getActivePlan(accountId, client);
    if (existing) return existing;

    const free: QueryResult<{ id: string | number }> = await db.query<{ id: string | number }>(
      `SELECT id FROM plans WHERE key = 'free' LIMIT 1`,
      []
    );
    const freeId = free.rows[0]?.id;
    if (freeId == null) {
      throw new Error("plans_catalog_missing_free");
    }

    await db.query(
      `INSERT INTO account_plans (account_id, plan_id, status, source)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (account_id) WHERE (status = 'active') DO NOTHING`,
      [accountId, freeId, source]
    );

    // Unique partial index may race; re-read active row.
    const after = await getActivePlan(accountId, client);
    if (!after) {
      throw new Error("account_plans_ensure_free_failed");
    }
    return after;
  } catch (error: unknown) {
    logCaught("plans.service.ensureFreePlanMembership", error);
    throw error;
  }
}

/** Active plan, inserting Free if missing. */
export async function getOrEnsureActivePlan(
  accountId: string,
  client?: PoolClient
): Promise<ActivePlanMembership> {
  const existing = await getActivePlan(accountId, client);
  if (existing) return existing;
  return ensureFreePlanMembership(accountId, client, "migration");
}

export async function listCatalogPlans(): Promise<PlanCatalogRow[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{
      id: string | number;
      key: string;
      display_name: string;
      price_usd_cents: number | null;
      included_credits: number | null;
      rate_limit_rpm: number | null;
      features: Record<string, unknown> | string;
    }> = await pool.query(
      `SELECT id, key, display_name, price_usd_cents, included_credits, rate_limit_rpm, features
       FROM plans
       ORDER BY CASE key
         WHEN 'free' THEN 1
         WHEN 'pro' THEN 2
         WHEN 'pay_as_you_go' THEN 3
         WHEN 'enterprise' THEN 4
         ELSE 99
       END,
       id ASC`
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      key: row.key,
      display_name: row.display_name,
      price_usd_cents: row.price_usd_cents,
      included_credits: row.included_credits,
      rate_limit_rpm: row.rate_limit_rpm,
      features: asFeatures(row.features),
    }));
  } catch (error: unknown) {
    logCaught("plans.service.listCatalogPlans", error);
    throw error;
  }
}

export function mapCatalogPlan(row: PlanCatalogRow) {
  return {
    key: row.key,
    displayName: row.display_name,
    priceUsdCents: row.price_usd_cents,
    includedCredits: row.included_credits,
    rateLimitRpm: row.rate_limit_rpm,
    features: row.features,
  };
}

export function mapAuthPlan(membership: ActivePlanMembership) {
  return {
    key: membership.key,
    displayName: membership.displayName,
    membershipId: membership.membershipId,
  };
}
