import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withAdminTransaction } from "../../infrastructure/db/with-admin-transaction";
import { logCaught } from "../../shared/utils/log";
import { appendAdminAudit } from "../admin/admin-audit.service";

export type FeatureCatalogErrorKind = "validation" | "not_found";

export class FeatureCatalogError extends Error {
  constructor(
    message: string,
    readonly kind: FeatureCatalogErrorKind
  ) {
    super(message);
    this.name = "FeatureCatalogError";
  }
}

export type FeatureCatalogEntry = {
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type PlanFeatureAccessEntry = {
  featureKey: string;
  label: string;
  planKeys: string[];
};

function slugifyLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** One JOIN, grouped by plan — the highlight bullets a plan's pricing card shows. */
export async function getHighlightsByPlan(): Promise<Map<string, string[]>> {
  try {
    const pool = getPool();
    const result: QueryResult<{ plan_key: string; label: string }> = await pool.query(
      `SELECT pf.plan_key, fc.label
       FROM plan_features pf
       JOIN feature_catalog fc ON fc.key = pf.feature_key
       ORDER BY pf.plan_key, fc.sort_order ASC, fc.label ASC`
    );
    const byPlan = new Map<string, string[]>();
    for (const row of result.rows) {
      const list = byPlan.get(row.plan_key) ?? [];
      list.push(row.label);
      byPlan.set(row.plan_key, list);
    }
    return byPlan;
  } catch (error: unknown) {
    logCaught("plans.plan-features.service.getHighlightsByPlan", error);
    throw error;
  }
}

/**
 * Whether an account effectively has a given feature right now — an
 * explicit per-account override (account_features) wins outright; with no
 * override, falls back to whether the account's active plan includes it.
 * Exported for future gating code to call — not wired into any code path
 * yet (infrastructure only, per the initial scope of this catalog).
 */
export async function hasFeature(accountId: string, featureKey: string): Promise<boolean> {
  try {
    const pool = getPool();
    const override: QueryResult<{ granted: boolean }> = await pool.query(
      `SELECT granted FROM account_features WHERE account_id = $1 AND feature_key = $2`,
      [accountId, featureKey]
    );
    if (override.rows.length > 0) {
      return override.rows[0].granted;
    }

    const result: QueryResult<{ exists: boolean }> = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM account_plans ap
         JOIN plans p ON p.id = ap.plan_id
         JOIN plan_features pf ON pf.plan_key = p.key AND pf.feature_key = $2
         WHERE ap.account_id = $1 AND ap.status = 'active'
       ) AS exists`,
      [accountId, featureKey]
    );
    return result.rows[0]?.exists ?? false;
  } catch (error: unknown) {
    logCaught("plans.plan-features.service.hasFeature", error);
    throw error;
  }
}

export type EffectiveFeatureEntry = {
  key: string;
  label: string;
  description: string | null;
  /** Does the account's active plan include this feature (before any override)? */
  fromPlan: boolean;
  /** null = no per-account override; true/false = an explicit grant/revoke. */
  override: boolean | null;
  /** The final answer hasFeature() would give: override ?? fromPlan. */
  enabled: boolean;
};

type EffectiveFeatureRow = {
  key: string;
  label: string;
  description: string | null;
  from_plan: boolean;
  override: boolean | null;
};

function mapEffectiveFeatureRow(row: EffectiveFeatureRow): EffectiveFeatureEntry {
  return {
    key: row.key,
    label: row.label,
    description: row.description,
    fromPlan: row.from_plan,
    override: row.override,
    enabled: row.override ?? row.from_plan,
  };
}

const EFFECTIVE_FEATURES_SQL = `
  SELECT
    fc.key, fc.label, fc.description,
    (pf.plan_key IS NOT NULL) AS from_plan,
    af.granted AS override
  FROM feature_catalog fc
  LEFT JOIN account_plans ap ON ap.account_id = $1 AND ap.status = 'active'
  LEFT JOIN plans p ON p.id = ap.plan_id
  LEFT JOIN plan_features pf ON pf.plan_key = p.key AND pf.feature_key = fc.key
  LEFT JOIN account_features af ON af.account_id = $1 AND af.feature_key = fc.key
`;

/** Every catalog feature, annotated with this one account's plan-derived and overridden state — powers the admin "see all features assigned to a user" view. */
export async function getEffectiveFeaturesForAccount(accountId: string): Promise<EffectiveFeatureEntry[]> {
  try {
    const pool = getPool();
    const result: QueryResult<EffectiveFeatureRow> = await pool.query(
      `${EFFECTIVE_FEATURES_SQL} ORDER BY fc.sort_order ASC, fc.label ASC`,
      [accountId]
    );
    return result.rows.map(mapEffectiveFeatureRow);
  } catch (error: unknown) {
    logCaught("plans.plan-features.service.getEffectiveFeaturesForAccount", error);
    throw error;
  }
}

async function getEffectiveFeatureForAccount(
  accountId: string,
  featureKey: string,
  client?: PoolClient
): Promise<EffectiveFeatureEntry> {
  const db = client ?? getPool();
  const result: QueryResult<EffectiveFeatureRow> = await db.query(
    `${EFFECTIVE_FEATURES_SQL} WHERE fc.key = $2`,
    [accountId, featureKey]
  );
  const row = result.rows[0];
  if (!row) {
    throw new FeatureCatalogError("Unknown feature", "not_found");
  }
  return mapEffectiveFeatureRow(row);
}

export async function setAccountFeatureOverride(input: {
  actorId: string;
  accountId: string;
  featureKey: string;
  granted: boolean;
}): Promise<EffectiveFeatureEntry> {
  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const feature = await client.query(`SELECT 1 FROM feature_catalog WHERE key = $1`, [input.featureKey]);
      if ((feature.rowCount ?? 0) === 0) {
        throw new FeatureCatalogError("Unknown feature", "not_found");
      }

      await client.query(
        `INSERT INTO account_features (account_id, feature_key, granted, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, feature_key)
         DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
        [input.accountId, input.featureKey, input.granted, input.actorId]
      );

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "account.set_feature_override",
          targetType: "account_features",
          targetId: `${input.accountId}:${input.featureKey}`,
          meta: { granted: input.granted },
        },
        client
      );

      return getEffectiveFeatureForAccount(input.accountId, input.featureKey, client);
    });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) throw error;
    logCaught("plans.plan-features.service.setAccountFeatureOverride", error);
    throw error;
  }
}

export async function clearAccountFeatureOverride(input: {
  actorId: string;
  accountId: string;
  featureKey: string;
}): Promise<EffectiveFeatureEntry> {
  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const feature = await client.query(`SELECT 1 FROM feature_catalog WHERE key = $1`, [input.featureKey]);
      if ((feature.rowCount ?? 0) === 0) {
        throw new FeatureCatalogError("Unknown feature", "not_found");
      }

      await client.query(
        `DELETE FROM account_features WHERE account_id = $1 AND feature_key = $2`,
        [input.accountId, input.featureKey]
      );

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "account.clear_feature_override",
          targetType: "account_features",
          targetId: `${input.accountId}:${input.featureKey}`,
        },
        client
      );

      return getEffectiveFeatureForAccount(input.accountId, input.featureKey, client);
    });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) throw error;
    logCaught("plans.plan-features.service.clearAccountFeatureOverride", error);
    throw error;
  }
}

export async function listFeatureCatalog(): Promise<FeatureCatalogEntry[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{
      key: string;
      label: string;
      description: string | null;
      sort_order: number;
    }> = await pool.query(
      `SELECT key, label, description, sort_order FROM feature_catalog ORDER BY sort_order ASC, label ASC`
    );
    return result.rows.map((row) => ({
      key: row.key,
      label: row.label,
      description: row.description,
      sortOrder: row.sort_order,
    }));
  } catch (error: unknown) {
    logCaught("plans.plan-features.service.listFeatureCatalog", error);
    throw error;
  }
}

export async function createFeature(input: {
  actorId: string;
  label: string;
  description?: string | null;
}): Promise<FeatureCatalogEntry> {
  const label = input.label.trim();
  if (!label) {
    throw new FeatureCatalogError("label is required", "validation");
  }
  const key = slugifyLabel(label);
  if (!key) {
    throw new FeatureCatalogError("label must contain at least one letter or number", "validation");
  }

  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const existing = await client.query(`SELECT 1 FROM feature_catalog WHERE key = $1`, [key]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new FeatureCatalogError(
          `A feature already exists with this name (key "${key}") — pick a different label`,
          "validation"
        );
      }

      const maxSort = await client.query<{ max: number | null }>(
        `SELECT MAX(sort_order) AS max FROM feature_catalog`
      );
      const sortOrder = (maxSort.rows[0]?.max ?? 0) + 10;

      const inserted = await client.query<{
        key: string;
        label: string;
        description: string | null;
        sort_order: number;
      }>(
        `INSERT INTO feature_catalog (key, label, description, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING key, label, description, sort_order`,
        [key, label, input.description?.trim() || null, sortOrder]
      );

      await appendAdminAudit(
        { adminUserId: input.actorId, action: "billing.create_feature", targetType: "feature_catalog", targetId: key, meta: { label } },
        client
      );

      const row = inserted.rows[0];
      return { key: row.key, label: row.label, description: row.description, sortOrder: row.sort_order };
    });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) throw error;
    logCaught("plans.plan-features.service.createFeature", error);
    throw error;
  }
}

export async function updateFeature(input: {
  actorId: string;
  key: string;
  label?: string;
  description?: string | null;
}): Promise<FeatureCatalogEntry> {
  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const current = await client.query<{ key: string; label: string; description: string | null; sort_order: number }>(
        `SELECT key, label, description, sort_order FROM feature_catalog WHERE key = $1`,
        [input.key]
      );
      const row = current.rows[0];
      if (!row) {
        throw new FeatureCatalogError("Unknown feature", "not_found");
      }

      const nextLabel = input.label !== undefined ? input.label.trim() : row.label;
      if (!nextLabel) {
        throw new FeatureCatalogError("label cannot be empty", "validation");
      }
      const nextDescription = input.description !== undefined ? input.description?.trim() || null : row.description;

      const updated = await client.query<{ key: string; label: string; description: string | null; sort_order: number }>(
        `UPDATE feature_catalog SET label = $2, description = $3, updated_at = now()
         WHERE key = $1
         RETURNING key, label, description, sort_order`,
        [input.key, nextLabel, nextDescription]
      );

      await appendAdminAudit(
        { adminUserId: input.actorId, action: "billing.update_feature", targetType: "feature_catalog", targetId: input.key, meta: { label: nextLabel, description: nextDescription } },
        client
      );

      const out = updated.rows[0];
      return { key: out.key, label: out.label, description: out.description, sortOrder: out.sort_order };
    });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) throw error;
    logCaught("plans.plan-features.service.updateFeature", error);
    throw error;
  }
}

export async function deleteFeature(input: { actorId: string; key: string }): Promise<void> {
  try {
    await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const result = await client.query(`DELETE FROM feature_catalog WHERE key = $1`, [input.key]);
      if ((result.rowCount ?? 0) === 0) {
        throw new FeatureCatalogError("Unknown feature", "not_found");
      }
      await appendAdminAudit(
        { adminUserId: input.actorId, action: "billing.delete_feature", targetType: "feature_catalog", targetId: input.key },
        client
      );
    });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) throw error;
    logCaught("plans.plan-features.service.deleteFeature", error);
    throw error;
  }
}

export async function listPlanFeatureAccess(): Promise<PlanFeatureAccessEntry[]> {
  try {
    const pool = getPool();
    const [features, links]: [
      QueryResult<{ key: string; label: string }>,
      QueryResult<{ plan_key: string; feature_key: string }>,
    ] = await Promise.all([
      pool.query(`SELECT key, label FROM feature_catalog ORDER BY sort_order ASC, label ASC`),
      pool.query(`SELECT plan_key, feature_key FROM plan_features`),
    ]);
    const byFeature = new Map<string, string[]>();
    for (const row of links.rows) {
      const list = byFeature.get(row.feature_key) ?? [];
      list.push(row.plan_key);
      byFeature.set(row.feature_key, list);
    }
    return features.rows.map((f) => ({
      featureKey: f.key,
      label: f.label,
      planKeys: byFeature.get(f.key) ?? [],
    }));
  } catch (error: unknown) {
    logCaught("plans.plan-features.service.listPlanFeatureAccess", error);
    throw error;
  }
}

export async function updatePlanFeatureAccess(input: {
  actorId: string;
  featureKey: string;
  planKeys: string[];
}): Promise<PlanFeatureAccessEntry> {
  const planKeys = [...new Set(input.planKeys)];

  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const feature = await client.query<{ key: string; label: string }>(
        `SELECT key, label FROM feature_catalog WHERE key = $1`,
        [input.featureKey]
      );
      const row = feature.rows[0];
      if (!row) {
        throw new FeatureCatalogError("Unknown feature", "not_found");
      }

      if (planKeys.length > 0) {
        const validPlans = await client.query<{ key: string }>(
          `SELECT key FROM plans WHERE key = ANY($1::text[])`,
          [planKeys]
        );
        const validKeys = new Set(validPlans.rows.map((r) => r.key));
        for (const key of planKeys) {
          if (!validKeys.has(key)) {
            throw new FeatureCatalogError(`Unknown plan "${key}"`, "validation");
          }
        }
      }

      await client.query(`DELETE FROM plan_features WHERE feature_key = $1`, [row.key]);
      for (const planKey of planKeys) {
        await client.query(`INSERT INTO plan_features (plan_key, feature_key) VALUES ($1, $2)`, [planKey, row.key]);
      }

      await appendAdminAudit(
        { adminUserId: input.actorId, action: "billing.update_plan_feature_access", targetType: "plan_features", targetId: row.key, meta: { planKeys } },
        client
      );

      return { featureKey: row.key, label: row.label, planKeys };
    });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) throw error;
    logCaught("plans.plan-features.service.updatePlanFeatureAccess", error);
    throw error;
  }
}
