import type { QueryResult } from "pg";
import { getPool } from "../../../infrastructure/db/pool";
import { decryptProviderKey } from "../../../shared/utils/provider-key-crypto";
import { setKey } from "./keyStore";
import { reloadHierarchy } from "../router";

type StoredKeyRow = { provider_id: string; encrypted_key: Buffer };

/**
 * Boot-time hydration: loads any admin-configured provider keys from
 * provider_api_keys into keyStore's in-memory override map (same effect as
 * an admin pasting a key into the panel — keyStore falls back to the
 * process env var for anything not found here), then builds the initial
 * routing hierarchy from provider_routing_rules. Call once before the
 * server starts accepting requests.
 */
export async function initProviderConfig(): Promise<void> {
  const pool = getPool();
  const result: QueryResult<StoredKeyRow> = await pool.query(
    `SELECT provider_id, encrypted_key
     FROM provider_api_keys
     WHERE is_active = true`
  );

  for (const row of result.rows) {
    try {
      setKey(row.provider_id, decryptProviderKey(row.encrypted_key));
    } catch (error: unknown) {
      console.error(
        `[provider-config-loader] failed to decrypt stored key for "${row.provider_id}" — falling back to env var`,
        error
      );
    }
  }

  await reloadHierarchy();
}
