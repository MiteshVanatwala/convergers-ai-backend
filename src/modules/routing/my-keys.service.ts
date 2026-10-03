import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import { decryptProviderKey, encryptProviderKey } from "../../shared/utils/provider-key-crypto";
import { maskKey } from "../brain/adapters/keyStore";

export type MyKeyErrorKind = "validation" | "not_found";

export class MyKeyError extends Error {
  constructor(
    message: string,
    readonly kind: MyKeyErrorKind
  ) {
    super(message);
    this.name = "MyKeyError";
  }
}

export type MyKeyInfo = {
  id: string;
  label: string;
  configured: boolean;
  maskedKey: string | null;
};

/** An account's own configured credentials — never shows a master key, only what the account itself added. */
export async function listMyKeys(accountId: string): Promise<MyKeyInfo[]> {
  try {
    const pool = getPool();
    const result: QueryResult<{ id: string; label: string; own_key: Buffer | null }> = await pool.query(
      `SELECT pc.id, pc.label, ak.encrypted_key AS own_key
       FROM provider_credentials pc
       LEFT JOIN provider_api_keys ak
         ON ak.provider_id = pc.id AND ak.account_id = $1 AND ak.is_active = true
       ORDER BY pc.label`,
      [accountId]
    );
    // A credential can have more than one active own-key row only via a race
    // (upsert deactivates-then-inserts) — the join above may return duplicate
    // pc rows in that rare case, so dedupe by credential id, keeping the
    // first (any) match.
    const byId = new Map<string, MyKeyInfo>();
    for (const row of result.rows) {
      if (byId.has(row.id)) continue;
      byId.set(row.id, {
        id: row.id,
        label: row.label,
        configured: row.own_key != null,
        maskedKey: row.own_key ? maskKey(decryptProviderKey(row.own_key)) : null,
      });
    }
    return [...byId.values()];
  } catch (error: unknown) {
    logCaught("routing.my-keys.service.listMyKeys", error);
    throw error;
  }
}

export async function setMyKey(input: {
  accountId: string;
  credentialId: string;
  apiKey: string;
}): Promise<MyKeyInfo> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new MyKeyError("apiKey is required", "validation");
  }

  try {
    const pool = getPool();
    const credential = await pool.query<{ id: string; label: string }>(
      `SELECT id, label FROM provider_credentials WHERE id = $1`,
      [input.credentialId]
    );
    const row = credential.rows[0];
    if (!row) {
      throw new MyKeyError("Unknown provider credential", "not_found");
    }

    await pool.query(
      `UPDATE provider_api_keys SET is_active = false
       WHERE provider_id = $1 AND account_id = $2 AND is_active = true`,
      [row.id, input.accountId]
    );
    await pool.query(
      `INSERT INTO provider_api_keys (provider_id, account_id, encrypted_key, source, is_active)
       VALUES ($1, $2, $3, 'override', true)`,
      [row.id, input.accountId, encryptProviderKey(apiKey)]
    );

    return {
      id: row.id,
      label: row.label,
      configured: true,
      maskedKey: maskKey(apiKey),
    };
  } catch (error: unknown) {
    if (error instanceof MyKeyError) throw error;
    logCaught("routing.my-keys.service.setMyKey", error);
    throw error;
  }
}

export async function deleteMyKey(input: { accountId: string; credentialId: string }): Promise<MyKeyInfo> {
  try {
    const pool = getPool();
    const credential = await pool.query<{ id: string; label: string }>(
      `SELECT id, label FROM provider_credentials WHERE id = $1`,
      [input.credentialId]
    );
    const row = credential.rows[0];
    if (!row) {
      throw new MyKeyError("Unknown provider credential", "not_found");
    }

    await pool.query(
      `UPDATE provider_api_keys SET is_active = false
       WHERE provider_id = $1 AND account_id = $2 AND is_active = true`,
      [row.id, input.accountId]
    );

    return { id: row.id, label: row.label, configured: false, maskedKey: null };
  } catch (error: unknown) {
    if (error instanceof MyKeyError) throw error;
    logCaught("routing.my-keys.service.deleteMyKey", error);
    throw error;
  }
}
