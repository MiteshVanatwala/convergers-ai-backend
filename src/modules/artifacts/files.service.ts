import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { getStorage } from "../../infrastructure/storage/object-storage";
import { logCaught } from "../../shared/utils/log";

export type FileKind = "image" | "artifact" | "audio";

export type StoredFileRow = {
  id: string;
  account_id: string;
  kind: FileKind;
  storage_key: string;
  content_type: string;
  byte_size: number;
  conversation_id: string | null;
  created_at: Date;
};

/**
 * Writes the bytes to object storage, then records the file. If the insert
 * fails, the stored object is removed so storage doesn't collect orphans.
 */
export async function saveFile(
  input: {
    accountId: string;
    kind: FileKind;
    key: string;
    body: Buffer;
    contentType: string;
    conversationId?: string | null;
  },
  db: PoolClient | ReturnType<typeof getPool> = getPool()
): Promise<StoredFileRow> {
  const storage = getStorage();
  await storage.put(input.key, input.body, input.contentType);
  try {
    const result: QueryResult<StoredFileRow> = await db.query(
      `INSERT INTO stored_files (account_id, kind, storage_key, content_type, byte_size, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id, account_id::text AS account_id, kind, storage_key, content_type,
                 byte_size::int AS byte_size, conversation_id::text AS conversation_id, created_at`,
      [input.accountId, input.kind, input.key, input.contentType, input.body.length, input.conversationId ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error("stored_files insert returned no row");
    return row;
  } catch (error: unknown) {
    await storage.delete(input.key).catch(() => {});
    logCaught("artifacts.files.service.saveFile", error);
    throw error;
  }
}

export async function getFile(id: string): Promise<StoredFileRow | null> {
  try {
    const result: QueryResult<StoredFileRow> = await getPool().query(
      `SELECT id::text AS id, account_id::text AS account_id, kind, storage_key, content_type,
              byte_size::int AS byte_size, conversation_id::text AS conversation_id, created_at
       FROM stored_files WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("artifacts.files.service.getFile", error);
    throw error;
  }
}

/** Reads a stored file fully into memory (artifact sources are small text). */
export async function readFileText(file: StoredFileRow): Promise<string | null> {
  const object = await getStorage().get(file.storage_key);
  if (!object) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** A file this account already stored under `key` (used as a cache for repeatable outputs). */
export async function findAccountFileByKey(accountId: string, key: string): Promise<StoredFileRow | null> {
  try {
    const result: QueryResult<StoredFileRow> = await getPool().query(
      `SELECT id::text AS id, account_id::text AS account_id, kind, storage_key, content_type,
              byte_size::int AS byte_size, conversation_id::text AS conversation_id, created_at
       FROM stored_files WHERE storage_key = $1 AND account_id = $2`,
      [key, accountId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("artifacts.files.service.findAccountFileByKey", error);
    throw error;
  }
}

/** An image generated in chat, with the conversation it came from (for the library). */
export type AccountImageRow = {
  id: string;
  content_type: string;
  conversation_id: string | null;
  conversation_title: string | null;
  created_at: Date;
};

/** The account's generated images, newest first. */
export async function listImagesForAccount(
  accountId: string,
  limit: number,
  offset: number
): Promise<AccountImageRow[]> {
  try {
    const result: QueryResult<AccountImageRow> = await getPool().query(
      `SELECT f.id::text AS id, f.content_type, f.conversation_id::text AS conversation_id,
              c.title AS conversation_title, f.created_at
       FROM stored_files f LEFT JOIN conversations c ON c.id = f.conversation_id
       WHERE f.account_id = $1 AND f.kind = 'image'
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("artifacts.files.service.listImagesForAccount", error);
    throw error;
  }
}
