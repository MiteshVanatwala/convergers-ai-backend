import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export type ProjectRow = {
  id: string;
  account_id: string;
  name: string;
  archived: boolean;
  conversation_count: string | number;
  created_at: Date;
  updated_at: Date;
};

const NAME_MAX = 80;

export function normalizeProjectName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

export function mapProject(row: ProjectRow) {
  return {
    id: String(row.id),
    name: row.name,
    archived: row.archived,
    conversationCount: Number(row.conversation_count) || 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listProjects(accountId: string): Promise<ProjectRow[]> {
  try {
    const result: QueryResult<ProjectRow> = await getPool().query(
      `SELECT p.id::text AS id,
              p.account_id::text AS account_id,
              p.name,
              p.archived,
              p.created_at,
              p.updated_at,
              COUNT(c.id)::int AS conversation_count
       FROM projects p
       LEFT JOIN conversations c
         ON c.project_id = p.id
        AND c.account_id = p.account_id
        AND c.archived = false
       WHERE p.account_id = $1 AND p.archived = false
       GROUP BY p.id
       ORDER BY lower(p.name) ASC, p.created_at ASC`,
      [accountId]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("projects.service.listProjects", error);
    throw error;
  }
}

export async function getProjectForAccount(
  accountId: string,
  projectId: string
): Promise<ProjectRow | null> {
  try {
    if (!/^\d+$/.test(projectId)) return null;
    const result: QueryResult<ProjectRow> = await getPool().query(
      `SELECT p.id::text AS id,
              p.account_id::text AS account_id,
              p.name,
              p.archived,
              p.created_at,
              p.updated_at,
              COUNT(c.id)::int AS conversation_count
       FROM projects p
       LEFT JOIN conversations c
         ON c.project_id = p.id
        AND c.account_id = p.account_id
        AND c.archived = false
       WHERE p.id = $1 AND p.account_id = $2 AND p.archived = false
       GROUP BY p.id
       LIMIT 1`,
      [projectId, accountId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("projects.service.getProjectForAccount", error);
    throw error;
  }
}

export async function createProject(accountId: string, name: string): Promise<ProjectRow> {
  try {
    const result: QueryResult<ProjectRow> = await getPool().query(
      `INSERT INTO projects (account_id, name)
       VALUES ($1, $2)
       RETURNING id::text AS id, account_id::text AS account_id, name, archived,
                 created_at, updated_at, 0::int AS conversation_count`,
      [accountId, name]
    );
    return result.rows[0];
  } catch (error: unknown) {
    logCaught("projects.service.createProject", error);
    throw error;
  }
}

export async function updateProject(
  accountId: string,
  projectId: string,
  patch: { name?: string }
): Promise<ProjectRow | null> {
  try {
    const existing = await getProjectForAccount(accountId, projectId);
    if (!existing) return null;

    const name = patch.name !== undefined ? patch.name : existing.name;

    const result: QueryResult<ProjectRow> = await getPool().query(
      `UPDATE projects
       SET name = $3, updated_at = now()
       WHERE id = $1 AND account_id = $2 AND archived = false
       RETURNING id::text AS id, account_id::text AS account_id, name, archived,
                 created_at, updated_at, $4::int AS conversation_count`,
      [projectId, accountId, name, existing.conversation_count]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("projects.service.updateProject", error);
    throw error;
  }
}

/** Soft-archive project and unlink its conversations in one transaction. */
export async function archiveProject(accountId: string, projectId: string): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    if (!/^\d+$/.test(projectId)) return false;
    await client.query("BEGIN");
    const archived = await client.query(
      `UPDATE projects
       SET archived = true, updated_at = now()
       WHERE id = $1 AND account_id = $2 AND archived = false`,
      [projectId, accountId]
    );
    if ((archived.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE conversations
       SET project_id = NULL
       WHERE project_id = $1 AND account_id = $2`,
      [projectId, accountId]
    );
    await client.query("COMMIT");
    return true;
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    logCaught("projects.service.archiveProject", error);
    throw error;
  } finally {
    client.release();
  }
}
