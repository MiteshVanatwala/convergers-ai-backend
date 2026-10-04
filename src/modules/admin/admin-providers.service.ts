import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withAdminTransaction } from "../../infrastructure/db/with-admin-transaction";
import { logCaught } from "../../shared/utils/log";
import { encryptProviderKey } from "../../shared/utils/provider-key-crypto";
import { getKey, isConfigured, keySource, maskKey, setKey } from "../brain/adapters/keyStore";
import { reloadHierarchy } from "../brain/router";
import { appendAdminAudit } from "./admin-audit.service";

export type ProviderConfigErrorKind = "validation" | "not_found";

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderConfigErrorKind
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export type CredentialInfo = {
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
  source: "override" | "env" | "none";
  maskedKey: string | null;
};

export type RoutingEntry = {
  taskType: string;
  providerId: string;
  label: string;
  rank: number;
  enabled: boolean;
  credentialConfigured: boolean;
};

export type RegistryEntry = {
  id: string;
  label: string;
  credentialId: string | null;
  credentialLabel: string | null;
  credentialConfigured: boolean;
  visible: boolean;
  capabilities: string[];
};

export type TierAccessEntry = {
  providerId: string;
  label: string;
  planKeys: string[];
};

const TASK_TYPES = ["text", "code", "research", "plan", "artifact", "image", "voice", "video"] as const;

export async function listCredentials(): Promise<CredentialInfo[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{ id: string; label: string; env_var: string }> = await pool.query(
      `SELECT id, label, env_var FROM provider_credentials ORDER BY label`
    );
    return result.rows.map((row) => {
      const key = getKey(row.id);
      return {
        id: row.id,
        label: row.label,
        envVar: row.env_var,
        configured: isConfigured(row.id),
        source: keySource(row.id),
        maskedKey: key ? maskKey(key) : null,
      };
    });
  } catch (error: unknown) {
    logCaught("admin.admin-providers.service.listCredentials", error);
    throw error;
  }
}

export async function setCredentialKey(input: {
  actorId: string;
  credentialId: string;
  apiKey: string;
}): Promise<CredentialInfo> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new ProviderConfigError("apiKey is required", "validation");
  }

  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const credential = await client.query<{ id: string; label: string; env_var: string }>(
        `SELECT id, label, env_var FROM provider_credentials WHERE id = $1`,
        [input.credentialId]
      );
      const row = credential.rows[0];
      if (!row) {
        throw new ProviderConfigError("Unknown provider credential", "not_found");
      }

      await client.query(
        `UPDATE provider_api_keys SET is_active = false WHERE provider_id = $1 AND is_active = true`,
        [row.id]
      );
      await client.query(
        `INSERT INTO provider_api_keys (provider_id, encrypted_key, source, is_active, created_by)
         VALUES ($1, $2, 'override', true, $3)`,
        [row.id, encryptProviderKey(apiKey), input.actorId]
      );

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "provider.set_key",
          targetType: "provider_credential",
          targetId: row.id,
          meta: {},
        },
        client
      );

      // Effective immediately, no restart — same UX as the old in-memory-only override.
      setKey(row.id, apiKey);

      return {
        id: row.id,
        label: row.label,
        envVar: row.env_var,
        configured: true,
        source: "override" as const,
        maskedKey: maskKey(apiKey),
      };
    });
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) throw error;
    logCaught("admin.admin-providers.service.setCredentialKey", error);
    throw error;
  }
}

export async function listRegistry(): Promise<RegistryEntry[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{
      id: string;
      label: string;
      visible_to_users: boolean;
      key_provider_id: string | null;
      credential_label: string | null;
      capabilities: string[];
    }> = await pool.query(
      `SELECT pr.id, pr.label, pr.visible_to_users, pr.key_provider_id, pc.label AS credential_label, pr.capabilities
       FROM provider_registry pr
       LEFT JOIN provider_credentials pc ON pc.id = pr.key_provider_id
       WHERE pr.status = 'active'
       ORDER BY pc.label NULLS LAST, pr.label`
    );
    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      credentialId: row.key_provider_id,
      credentialLabel: row.credential_label,
      credentialConfigured: row.key_provider_id ? isConfigured(row.key_provider_id) : false,
      visible: row.visible_to_users,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    }));
  } catch (error: unknown) {
    logCaught("admin.admin-providers.service.listRegistry", error);
    throw error;
  }
}

export async function setVisibility(input: {
  actorId: string;
  providerId: string;
  visible: boolean;
}): Promise<RegistryEntry> {
  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const result = await client.query<{
        id: string;
        label: string;
        visible_to_users: boolean;
        key_provider_id: string | null;
        capabilities: string[];
      }>(
        `UPDATE provider_registry
         SET visible_to_users = $2
         WHERE id = $1
         RETURNING id, label, visible_to_users, key_provider_id, capabilities`,
        [input.providerId, input.visible]
      );
      const row = result.rows[0];
      if (!row) {
        throw new ProviderConfigError("Unknown provider", "not_found");
      }

      let credentialLabel: string | null = null;
      if (row.key_provider_id) {
        const cred = await client.query<{ label: string }>(
          `SELECT label FROM provider_credentials WHERE id = $1`,
          [row.key_provider_id]
        );
        credentialLabel = cred.rows[0]?.label ?? null;
      }

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "provider.set_visibility",
          targetType: "provider_registry",
          targetId: row.id,
          meta: { visible: input.visible },
        },
        client
      );

      return {
        id: row.id,
        label: row.label,
        credentialId: row.key_provider_id,
        credentialLabel,
        credentialConfigured: row.key_provider_id ? isConfigured(row.key_provider_id) : false,
        visible: row.visible_to_users,
        capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
      };
    }).then(async (entry) => {
      // Effective immediately, no restart.
      await reloadHierarchy();
      return entry;
    });
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) throw error;
    logCaught("admin.admin-providers.service.setVisibility", error);
    throw error;
  }
}

export async function setCapabilities(input: {
  actorId: string;
  providerId: string;
  capabilities: string[];
}): Promise<RegistryEntry> {
  const capabilities = [...new Set(input.capabilities)];
  for (const cap of capabilities) {
    if (!(TASK_TYPES as readonly string[]).includes(cap)) {
      throw new ProviderConfigError(`Unknown capability "${cap}"`, "validation");
    }
  }

  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const result = await client.query<{
        id: string;
        label: string;
        visible_to_users: boolean;
        key_provider_id: string | null;
        capabilities: string[];
      }>(
        `UPDATE provider_registry
         SET capabilities = $2::jsonb
         WHERE id = $1
         RETURNING id, label, visible_to_users, key_provider_id, capabilities`,
        [input.providerId, JSON.stringify(capabilities)]
      );
      const row = result.rows[0];
      if (!row) {
        throw new ProviderConfigError("Unknown provider", "not_found");
      }

      let credentialLabel: string | null = null;
      if (row.key_provider_id) {
        const cred = await client.query<{ label: string }>(
          `SELECT label FROM provider_credentials WHERE id = $1`,
          [row.key_provider_id]
        );
        credentialLabel = cred.rows[0]?.label ?? null;
      }

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "provider.set_capabilities",
          targetType: "provider_registry",
          targetId: row.id,
          meta: { capabilities },
        },
        client
      );

      return {
        id: row.id,
        label: row.label,
        credentialId: row.key_provider_id,
        credentialLabel,
        credentialConfigured: row.key_provider_id ? isConfigured(row.key_provider_id) : false,
        visible: row.visible_to_users,
        capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
      };
      // No reloadHierarchy() — capabilities is descriptive metadata, it
      // doesn't feed the router's in-memory hierarchy the way
      // visibility/routing rules do.
    });
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) throw error;
    logCaught("admin.admin-providers.service.setCapabilities", error);
    throw error;
  }
}

export async function listRoutingRules(): Promise<Record<string, RoutingEntry[]>> {
  try {
    const pool = getPool();
    const result: QueryResult<{
      task_type: string;
      provider_id: string;
      label: string;
      rank: number;
      enabled: boolean;
      key_provider_id: string | null;
    }> = await pool.query(
      `SELECT rr.task_type, rr.provider_id, pr.label, rr.rank, rr.enabled, pr.key_provider_id
       FROM provider_routing_rules rr
       JOIN provider_registry pr ON pr.id = rr.provider_id
       ORDER BY rr.task_type, rr.rank ASC`
    );

    const byTaskType: Record<string, RoutingEntry[]> = {};
    for (const taskType of TASK_TYPES) byTaskType[taskType] = [];

    for (const row of result.rows) {
      const list = byTaskType[row.task_type] ?? (byTaskType[row.task_type] = []);
      list.push({
        taskType: row.task_type,
        providerId: row.provider_id,
        label: row.label,
        rank: row.rank,
        enabled: row.enabled,
        credentialConfigured: row.key_provider_id ? isConfigured(row.key_provider_id) : false,
      });
    }
    return byTaskType;
  } catch (error: unknown) {
    logCaught("admin.admin-providers.service.listRoutingRules", error);
    throw error;
  }
}

export async function updateRoutingRules(input: {
  actorId: string;
  taskType: string;
  entries: Array<{ providerId: string; enabled: boolean }>;
}): Promise<RoutingEntry[]> {
  if (!(TASK_TYPES as readonly string[]).includes(input.taskType)) {
    throw new ProviderConfigError(`taskType must be one of: ${TASK_TYPES.join(", ")}`, "validation");
  }
  if (input.entries.length === 0) {
    throw new ProviderConfigError("entries must not be empty", "validation");
  }
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (seen.has(entry.providerId)) {
      throw new ProviderConfigError(`duplicate providerId "${entry.providerId}"`, "validation");
    }
    seen.add(entry.providerId);
  }

  try {
    const result = await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const known = await client.query<{ id: string; label: string; key_provider_id: string | null }>(
        `SELECT id, label, key_provider_id FROM provider_registry WHERE id = ANY($1::text[])`,
        [input.entries.map((e) => e.providerId)]
      );
      const knownById = new Map(known.rows.map((r) => [r.id, r]));
      for (const entry of input.entries) {
        if (!knownById.has(entry.providerId)) {
          throw new ProviderConfigError(`Unknown provider "${entry.providerId}"`, "validation");
        }
      }

      await client.query(`DELETE FROM provider_routing_rules WHERE task_type = $1`, [input.taskType]);

      const rows: RoutingEntry[] = [];
      for (let i = 0; i < input.entries.length; i++) {
        const entry = input.entries[i];
        const rank = i + 1;
        await client.query(
          `INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
           VALUES ($1, $2, $3, $4)`,
          [input.taskType, entry.providerId, rank, entry.enabled]
        );
        const meta = knownById.get(entry.providerId)!;
        rows.push({
          taskType: input.taskType,
          providerId: entry.providerId,
          label: meta.label,
          rank,
          enabled: entry.enabled,
          credentialConfigured: meta.key_provider_id ? isConfigured(meta.key_provider_id) : false,
        });
      }

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "provider.update_routing",
          targetType: "provider_routing_rules",
          targetId: input.taskType,
          meta: { entries: input.entries },
        },
        client
      );

      return rows;
    });

    // Effective immediately, no restart.
    await reloadHierarchy();
    return result;
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) throw error;
    logCaught("admin.admin-providers.service.updateRoutingRules", error);
    throw error;
  }
}

/**
 * Which plans can use each model via the *master* key (provider_tier_access)
 * — independent of visibility/routing above. An account's own key always
 * bypasses this, regardless of what's configured here (see
 * accountKeyResolver.ts).
 */
export async function listTierAccess(): Promise<TierAccessEntry[]> {
  try {
    const pool = getPool();
    const [registry, tier] = await Promise.all([
      pool.query<{ id: string; label: string }>(
        `SELECT id, label FROM provider_registry WHERE status = 'active' ORDER BY label`
      ),
      pool.query<{ provider_id: string; plan_key: string }>(
        `SELECT provider_id, plan_key FROM provider_tier_access`
      ),
    ]);
    const byProvider = new Map<string, string[]>();
    for (const row of tier.rows) {
      const list = byProvider.get(row.provider_id) ?? [];
      list.push(row.plan_key);
      byProvider.set(row.provider_id, list);
    }
    return registry.rows.map((row) => ({
      providerId: row.id,
      label: row.label,
      planKeys: byProvider.get(row.id) ?? [],
    }));
  } catch (error: unknown) {
    logCaught("admin.admin-providers.service.listTierAccess", error);
    throw error;
  }
}

export async function updateTierAccess(input: {
  actorId: string;
  providerId: string;
  planKeys: string[];
}): Promise<TierAccessEntry> {
  const planKeys = [...new Set(input.planKeys)];

  try {
    return await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      const registry = await client.query<{ id: string; label: string }>(
        `SELECT id, label FROM provider_registry WHERE id = $1`,
        [input.providerId]
      );
      const row = registry.rows[0];
      if (!row) {
        throw new ProviderConfigError("Unknown provider", "not_found");
      }

      if (planKeys.length > 0) {
        const validPlans = await client.query<{ key: string }>(
          `SELECT key FROM plans WHERE key = ANY($1::text[])`,
          [planKeys]
        );
        const validKeys = new Set(validPlans.rows.map((r) => r.key));
        for (const key of planKeys) {
          if (!validKeys.has(key)) {
            throw new ProviderConfigError(`Unknown plan "${key}"`, "validation");
          }
        }
      }

      await client.query(`DELETE FROM provider_tier_access WHERE provider_id = $1`, [row.id]);
      for (const planKey of planKeys) {
        await client.query(
          `INSERT INTO provider_tier_access (provider_id, plan_key) VALUES ($1, $2)`,
          [row.id, planKey]
        );
      }

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "provider.update_tier_access",
          targetType: "provider_tier_access",
          targetId: row.id,
          meta: { planKeys },
        },
        client
      );

      return { providerId: row.id, label: row.label, planKeys };
    });
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) throw error;
    logCaught("admin.admin-providers.service.updateTierAccess", error);
    throw error;
  }
}
