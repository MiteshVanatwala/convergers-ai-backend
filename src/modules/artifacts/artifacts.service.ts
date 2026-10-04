import type { PoolClient, QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { getStorage } from "../../infrastructure/storage/object-storage";
import { logCaught } from "../../shared/utils/log";
import type { ArtifactType, ParsedArtifact } from "./artifact-parser";
import { saveFile } from "./files.service";

export type Visibility = "private" | "organization" | "link" | "public";
export const VISIBILITIES: readonly Visibility[] = ["private", "organization", "link", "public"];

export type ArtifactRow = {
  id: string;
  account_id: string;
  conversation_id: string | null;
  identifier: string | null;
  title: string;
  type: ArtifactType;
  language: string | null;
  current_version: number;
  visibility: Visibility;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  owner_name: string | null;
};

const ARTIFACT_COLUMNS = `a.id::text AS id, a.account_id::text AS account_id, a.conversation_id::text AS conversation_id,
  a.identifier, a.title, a.type, a.language, a.current_version, a.visibility, a.published_at,
  a.created_at, a.updated_at, acc.name AS owner_name`;

const EXTENSION: Record<ArtifactType, string> = {
  html: "html",
  react: "jsx",
  svg: "svg",
  markdown: "md",
  mermaid: "mmd",
  code: "txt",
};

const CONTENT_TYPE: Record<ArtifactType, string> = {
  html: "text/html; charset=utf-8",
  react: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  markdown: "text/markdown; charset=utf-8",
  mermaid: "text/plain; charset=utf-8",
  code: "text/plain; charset=utf-8",
};

/** Largest artifact source accepted (text). */
export const MAX_ARTIFACT_BYTES = 1_000_000;

/**
 * Saves one artifact from a chat answer. Reusing an identifier the same
 * conversation already has adds a new version to that artifact; anything
 * else creates a new artifact (private to the owner).
 */
export async function saveFromChat(input: {
  accountId: string;
  conversationId: string;
  artifact: ParsedArtifact;
}): Promise<{ id: string; version: number; type: ArtifactType; title: string }> {
  const body = Buffer.from(input.artifact.content, "utf8");
  if (body.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact is too large to store");
  try {
    return await withPoolTransaction(async (client: PoolClient) => {
      let artifactId: string | null = null;
      let version = 1;
      if (input.artifact.identifier) {
        const existing: QueryResult<{ id: string; current_version: number }> = await client.query(
          `SELECT id::text AS id, current_version FROM artifacts
           WHERE conversation_id = $1 AND identifier = $2 AND account_id = $3 AND deleted_at IS NULL
           FOR UPDATE`,
          [input.conversationId, input.artifact.identifier, input.accountId]
        );
        if (existing.rows[0]) {
          artifactId = existing.rows[0].id;
          version = existing.rows[0].current_version + 1;
        }
      }
      if (!artifactId) {
        const created: QueryResult<{ id: string }> = await client.query(
          `INSERT INTO artifacts (account_id, conversation_id, identifier, title, type, language)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
          [
            input.accountId,
            input.conversationId,
            input.artifact.identifier,
            input.artifact.title,
            input.artifact.type,
            input.artifact.language,
          ]
        );
        artifactId = created.rows[0]!.id;
      }

      const file = await saveFile(
        {
          accountId: input.accountId,
          kind: "artifact",
          key: `artifacts/${artifactId}/v${version}.${EXTENSION[input.artifact.type]}`,
          body,
          contentType: CONTENT_TYPE[input.artifact.type],
          conversationId: input.conversationId,
        },
        client
      );
      await client.query(
        `INSERT INTO artifact_versions (artifact_id, version, file_id) VALUES ($1, $2, $3)`,
        [artifactId, version, file.id]
      );
      if (version > 1) {
        await client.query(
          `UPDATE artifacts SET current_version = $2, title = $3, type = $4, language = $5, updated_at = now()
           WHERE id = $1`,
          [artifactId, version, input.artifact.title, input.artifact.type, input.artifact.language]
        );
      }
      return { id: artifactId, version, type: input.artifact.type, title: input.artifact.title };
    });
  } catch (error: unknown) {
    logCaught("artifacts.service.saveFromChat", error);
    throw error;
  }
}

export async function getArtifact(id: string): Promise<ArtifactRow | null> {
  try {
    const result: QueryResult<ArtifactRow> = await getPool().query(
      `SELECT ${ARTIFACT_COLUMNS}
       FROM artifacts a JOIN accounts acc ON acc.id = a.account_id
       WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("artifacts.service.getArtifact", error);
    throw error;
  }
}

/**
 * Who may open an artifact: its owner always; then by visibility —
 * link/public: anyone; organization: a signed-in member of the owner's
 * current organization.
 */
export async function canView(artifact: ArtifactRow, viewerId: string | null): Promise<boolean> {
  if (viewerId === artifact.account_id) return true;
  if (artifact.visibility === "link" || artifact.visibility === "public") return true;
  if (artifact.visibility !== "organization" || !viewerId) return false;
  try {
    const result = await getPool().query(
      `SELECT 1 FROM organization_members owner
       JOIN organization_members viewer ON viewer.org_id = owner.org_id
       WHERE owner.account_id = $1 AND viewer.account_id = $2`,
      [artifact.account_id, viewerId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("artifacts.service.canView", error);
    throw error;
  }
}

export async function getVersionFileKey(
  artifactId: string,
  version: number
): Promise<{ storage_key: string; content_type: string } | null> {
  try {
    const result: QueryResult<{ storage_key: string; content_type: string }> = await getPool().query(
      `SELECT f.storage_key, f.content_type
       FROM artifact_versions v JOIN stored_files f ON f.id = v.file_id
       WHERE v.artifact_id = $1 AND v.version = $2`,
      [artifactId, version]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("artifacts.service.getVersionFileKey", error);
    throw error;
  }
}

export async function readVersionText(artifactId: string, version: number): Promise<string | null> {
  const file = await getVersionFileKey(artifactId, version);
  if (!file) return null;
  const object = await getStorage().get(file.storage_key);
  if (!object) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function listForAccount(accountId: string, limit: number, offset: number): Promise<ArtifactRow[]> {
  try {
    const result: QueryResult<ArtifactRow> = await getPool().query(
      `SELECT ${ARTIFACT_COLUMNS}
       FROM artifacts a JOIN accounts acc ON acc.id = a.account_id
       WHERE a.account_id = $1 AND a.deleted_at IS NULL
       ORDER BY a.updated_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("artifacts.service.listForAccount", error);
    throw error;
  }
}

/** The public gallery: newest published first. */
export async function listPublic(limit: number, offset: number): Promise<ArtifactRow[]> {
  try {
    const result: QueryResult<ArtifactRow> = await getPool().query(
      `SELECT ${ARTIFACT_COLUMNS}
       FROM artifacts a JOIN accounts acc ON acc.id = a.account_id
       WHERE a.visibility = 'public' AND a.deleted_at IS NULL
       ORDER BY a.published_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("artifacts.service.listPublic", error);
    throw error;
  }
}

export async function updateArtifact(
  id: string,
  accountId: string,
  input: { title?: string; visibility?: Visibility }
): Promise<boolean> {
  try {
    const sets: string[] = [];
    const params: unknown[] = [id, accountId];
    if (input.title !== undefined) {
      params.push(input.title);
      sets.push(`title = $${params.length}`);
    }
    if (input.visibility !== undefined) {
      params.push(input.visibility);
      sets.push(`visibility = $${params.length}`);
      sets.push(`published_at = CASE WHEN $${params.length} = 'public' THEN COALESCE(published_at, now()) ELSE published_at END`);
    }
    if (sets.length === 0) return true;
    const result = await getPool().query(
      `UPDATE artifacts SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
      params
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("artifacts.service.updateArtifact", error);
    throw error;
  }
}

/** Hides the artifact everywhere (shared links stop working) and removes its stored files. */
export async function deleteArtifact(id: string, accountId: string): Promise<boolean> {
  try {
    const keys = await withPoolTransaction(async (client: PoolClient) => {
      const updated = await client.query(
        `UPDATE artifacts SET deleted_at = now(), visibility = 'private'
         WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
        [id, accountId]
      );
      if ((updated.rowCount ?? 0) === 0) return null;
      const files: QueryResult<{ storage_key: string }> = await client.query(
        `SELECT f.storage_key FROM artifact_versions v JOIN stored_files f ON f.id = v.file_id
         WHERE v.artifact_id = $1`,
        [id]
      );
      return files.rows.map((r) => r.storage_key);
    });
    if (!keys) return false;
    const storage = getStorage();
    await Promise.all(keys.map((key) => storage.delete(key).catch(() => {})));
    return true;
  } catch (error: unknown) {
    logCaught("artifacts.service.deleteArtifact", error);
    throw error;
  }
}
