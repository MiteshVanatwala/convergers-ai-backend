import type { QueryResult } from "pg";
import type { AnswerMetadata } from "@convergers-ai/shared-types";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";

export type TitleStatus = "pending" | "generated" | "manual";
export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "complete" | "error" | "cancelled";

export type ConversationRow = {
  id: string;
  account_id: string;
  project_id: string | null;
  title: string | null;
  title_status: TitleStatus;
  pinned: boolean;
  archived: boolean;
  last_message_at: Date;
  created_at: Date;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  account_id: string;
  role: MessageRole;
  content: string;
  provider: string | null;
  task_type: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  credits_charged: string | number | null;
  status: MessageStatus;
  created_at: Date;
  metadata: AnswerMetadata | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** messages.id is a bigint identity, sent to clients as a decimal string. */
export function isMessageId(value: string): boolean {
  return /^[1-9]\d{0,18}$/.test(value);
}

export function provisionalTitle(prompt: string, max = 60): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

const CONVERSATION_COLUMNS = `id::text AS id, account_id::text AS account_id,
       project_id::text AS project_id, title, title_status,
       pinned, archived, last_message_at, created_at`;

const MESSAGE_COLUMNS = `id::text AS id, conversation_id::text AS conversation_id,
       account_id::text AS account_id, role, content, provider, task_type,
       tokens_input, tokens_output, credits_charged, status, created_at, metadata`;

export function mapConversation(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    titleStatus: row.title_status,
    pinned: row.pinned,
    archived: row.archived,
    projectId: row.project_id != null ? String(row.project_id) : null,
    lastMessageAt:
      row.last_message_at instanceof Date
        ? row.last_message_at.toISOString()
        : new Date(row.last_message_at).toISOString(),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  };
}

export function mapMessage(row: MessageRow) {
  return {
    id: String(row.id),
    role: row.role,
    content: row.content,
    provider: row.provider,
    taskType: row.task_type,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    creditsCharged: asNumber(row.credits_charged),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}

export async function listConversations(accountId: string): Promise<ConversationRow[]> {
  try {
    const result: QueryResult<ConversationRow> = await getPool().query(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM conversations
       WHERE account_id = $1 AND archived = false
       ORDER BY pinned DESC, last_message_at DESC, id DESC
       LIMIT 200`,
      [accountId]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("conversations.service.listConversations", error);
    throw error;
  }
}

export type ConversationScope = "recents" | "pinned" | "assigned" | "all";

export type RecentsCursor = { t: string; id: string };

export function encodeRecentsCursor(row: ConversationRow): string {
  const t =
    row.last_message_at instanceof Date
      ? row.last_message_at.toISOString()
      : new Date(row.last_message_at).toISOString();
  return Buffer.from(JSON.stringify({ t, id: row.id }), "utf8").toString("base64url");
}

export function decodeRecentsCursor(raw: string): RecentsCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { t?: unknown }).t !== "string" ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      !isUuid((parsed as { id: string }).id)
    ) {
      return null;
    }
    const t = (parsed as { t: string }).t;
    if (Number.isNaN(Date.parse(t))) return null;
    return { t, id: (parsed as { id: string }).id };
  } catch {
    return null;
  }
}

export async function listPinnedConversations(
  accountId: string,
  limit = 100
): Promise<ConversationRow[]> {
  try {
    const result: QueryResult<ConversationRow> = await getPool().query(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM conversations
       WHERE account_id = $1 AND archived = false AND pinned = true
       ORDER BY last_message_at DESC, id DESC
       LIMIT $2`,
      [accountId, limit]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("conversations.service.listPinnedConversations", error);
    throw error;
  }
}

export async function listAssignedConversations(
  accountId: string,
  limit = 500
): Promise<ConversationRow[]> {
  try {
    const result: QueryResult<ConversationRow> = await getPool().query(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM conversations
       WHERE account_id = $1
         AND archived = false
         AND pinned = false
         AND project_id IS NOT NULL
       ORDER BY last_message_at DESC, id DESC
       LIMIT $2`,
      [accountId, limit]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("conversations.service.listAssignedConversations", error);
    throw error;
  }
}

export async function listRecentsPage(
  accountId: string,
  limit: number,
  cursor: RecentsCursor | null
): Promise<{ rows: ConversationRow[]; nextCursor: string | null }> {
  try {
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const fetchLimit = pageSize + 1;
    const result: QueryResult<ConversationRow> = cursor
      ? await getPool().query(
          `SELECT ${CONVERSATION_COLUMNS}
           FROM conversations
           WHERE account_id = $1
             AND archived = false
             AND pinned = false
             AND project_id IS NULL
             AND (
               last_message_at < $2::timestamptz
               OR (last_message_at = $2::timestamptz AND id < $3::uuid)
             )
           ORDER BY last_message_at DESC, id DESC
           LIMIT $4`,
          [accountId, cursor.t, cursor.id, fetchLimit]
        )
      : await getPool().query(
          `SELECT ${CONVERSATION_COLUMNS}
           FROM conversations
           WHERE account_id = $1
             AND archived = false
             AND pinned = false
             AND project_id IS NULL
           ORDER BY last_message_at DESC, id DESC
           LIMIT $2`,
          [accountId, fetchLimit]
        );

    const hasMore = result.rows.length > pageSize;
    const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
    const nextCursor =
      hasMore && rows.length > 0 ? encodeRecentsCursor(rows[rows.length - 1]) : null;
    return { rows, nextCursor };
  } catch (error: unknown) {
    logCaught("conversations.service.listRecentsPage", error);
    throw error;
  }
}

export async function getConversationForAccount(
  accountId: string,
  conversationId: string
): Promise<ConversationRow | null> {
  try {
    if (!isUuid(conversationId)) return null;
    const result: QueryResult<ConversationRow> = await getPool().query(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM conversations
       WHERE id = $1 AND account_id = $2 AND archived = false
       LIMIT 1`,
      [conversationId, accountId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("conversations.service.getConversationForAccount", error);
    throw error;
  }
}

export async function listMessages(
  accountId: string,
  conversationId: string,
  limit = 500
): Promise<MessageRow[]> {
  try {
    const conversation = await getConversationForAccount(accountId, conversationId);
    if (!conversation) return [];

    const result: QueryResult<MessageRow> = await getPool().query(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages
       WHERE conversation_id = $1 AND account_id = $2
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [conversationId, accountId, limit]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("conversations.service.listMessages", error);
    throw error;
  }
}

/** A user message in this conversation — the start of a turn. Null if it isn't one. */
const TURN_START = `
  SELECT id, created_at FROM messages
  WHERE id = $3::bigint AND conversation_id = $1 AND account_id = $2 AND role = 'user'`;

/**
 * Deletes one turn: the user message `messageId` and the assistant reply
 * straight after it. False when `messageId` isn't a user message here.
 */
export async function deleteTurn(
  accountId: string,
  conversationId: string,
  messageId: string
): Promise<boolean> {
  try {
    const result = await getPool().query(
      `WITH target AS (${TURN_START}),
       reply AS (
         SELECT m.id, m.role FROM messages m, target t
         WHERE m.conversation_id = $1 AND m.account_id = $2
           AND (m.created_at, m.id) > (t.created_at, t.id)
         ORDER BY m.created_at, m.id
         LIMIT 1
       )
       DELETE FROM messages
       WHERE conversation_id = $1 AND account_id = $2
         AND (id IN (SELECT id FROM target)
              OR id IN (SELECT id FROM reply WHERE role = 'assistant'))
       RETURNING role`,
      [conversationId, accountId, messageId]
    );
    return result.rows.some((r: { role: string }) => r.role === "user");
  } catch (error: unknown) {
    logCaught("conversations.service.deleteTurn", error);
    throw error;
  }
}

/**
 * Deletes the turn starting at user message `messageId` and every message
 * after it — what edit and regenerate replace. False when `messageId` isn't
 * a user message here.
 */
export async function deleteFromMessage(
  accountId: string,
  conversationId: string,
  messageId: string
): Promise<boolean> {
  try {
    const result = await getPool().query(
      `WITH target AS (${TURN_START})
       DELETE FROM messages m
       USING target t
       WHERE m.conversation_id = $1 AND m.account_id = $2
         AND (m.created_at, m.id) >= (t.created_at, t.id)`,
      [conversationId, accountId, messageId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("conversations.service.deleteFromMessage", error);
    throw error;
  }
}

export async function createConversation(
  accountId: string,
  title: string
): Promise<ConversationRow> {
  try {
    const result: QueryResult<ConversationRow> = await getPool().query(
      `INSERT INTO conversations (account_id, title, title_status, last_message_at)
       VALUES ($1, $2, 'pending', now())
       RETURNING ${CONVERSATION_COLUMNS}`,
      [accountId, title]
    );
    return result.rows[0];
  } catch (error: unknown) {
    logCaught("conversations.service.createConversation", error);
    throw error;
  }
}

export async function touchConversation(conversationId: string): Promise<void> {
  try {
    await getPool().query(
      `UPDATE conversations SET last_message_at = now() WHERE id = $1`,
      [conversationId]
    );
  } catch (error: unknown) {
    logCaught("conversations.service.touchConversation", error);
    throw error;
  }
}

export async function insertMessage(input: {
  conversationId: string;
  accountId: string;
  role: MessageRole;
  content: string;
  provider?: string | null;
  taskType?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  creditsCharged?: number | null;
  status?: MessageStatus;
  metadata?: AnswerMetadata | null;
}): Promise<MessageRow> {
  try {
    const result: QueryResult<MessageRow> = await getPool().query(
      `INSERT INTO messages (
         conversation_id, account_id, role, content,
         provider, task_type, tokens_input, tokens_output, credits_charged, status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        input.conversationId,
        input.accountId,
        input.role,
        input.content,
        input.provider ?? null,
        input.taskType ?? null,
        input.tokensInput ?? null,
        input.tokensOutput ?? null,
        input.creditsCharged ?? null,
        input.status ?? "complete",
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );
    await touchConversation(input.conversationId);
    return result.rows[0];
  } catch (error: unknown) {
    logCaught("conversations.service.insertMessage", error);
    throw error;
  }
}

export async function updateConversation(
  accountId: string,
  conversationId: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null }
): Promise<ConversationRow | null | "invalid_project"> {
  try {
    const existing = await getConversationForAccount(accountId, conversationId);
    if (!existing) return null;

    const title = patch.title !== undefined ? patch.title.trim() || null : existing.title;
    const titleStatus =
      patch.title !== undefined ? ("manual" as TitleStatus) : existing.title_status;
    const pinned = patch.pinned ?? existing.pinned;
    const archived = patch.archived ?? existing.archived;

    let projectId: string | null = existing.project_id;
    if (patch.projectId !== undefined) {
      if (patch.projectId === null) {
        projectId = null;
      } else if (!/^\d+$/.test(patch.projectId)) {
        return "invalid_project";
      } else {
        const owned = await getPool().query(
          `SELECT 1 FROM projects
           WHERE id = $1 AND account_id = $2 AND archived = false
           LIMIT 1`,
          [patch.projectId, accountId]
        );
        if ((owned.rowCount ?? 0) === 0) return "invalid_project";
        projectId = patch.projectId;
      }
    }

    const result: QueryResult<ConversationRow> = await getPool().query(
      `UPDATE conversations
       SET title = $3, title_status = $4, pinned = $5, archived = $6, project_id = $7
       WHERE id = $1 AND account_id = $2
       RETURNING ${CONVERSATION_COLUMNS}`,
      [conversationId, accountId, title, titleStatus, pinned, archived, projectId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("conversations.service.updateConversation", error);
    throw error;
  }
}

export async function archiveConversation(
  accountId: string,
  conversationId: string
): Promise<boolean> {
  try {
    const result = await getPool().query(
      `UPDATE conversations
       SET archived = true
       WHERE id = $1 AND account_id = $2 AND archived = false`,
      [conversationId, accountId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("conversations.service.archiveConversation", error);
    throw error;
  }
}

export async function setGeneratedTitle(
  accountId: string,
  conversationId: string,
  title: string
): Promise<ConversationRow | null> {
  try {
    const result: QueryResult<ConversationRow> = await getPool().query(
      `UPDATE conversations
       SET title = $3, title_status = 'generated'
       WHERE id = $1 AND account_id = $2 AND title_status = 'pending'
       RETURNING ${CONVERSATION_COLUMNS}`,
      [conversationId, accountId, title]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("conversations.service.setGeneratedTitle", error);
    throw error;
  }
}

/** One assistant message of this account's conversation, with the prompt it answered. */
export async function getAnswerWithPrompt(
  accountId: string,
  conversationId: string,
  messageId: string
): Promise<{ answer: MessageRow; prompt: MessageRow | null; history: MessageRow[] } | null> {
  try {
    const result: QueryResult<MessageRow> = await getPool().query(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages
       WHERE conversation_id = $1 AND account_id = $2
       ORDER BY created_at ASC, id ASC`,
      [conversationId, accountId]
    );
    const index = result.rows.findIndex((m) => m.id === messageId);
    const answer = result.rows[index];
    if (!answer || answer.role !== "assistant") return null;
    const before = result.rows.slice(0, index);
    const prompt = before.length > 0 && before[before.length - 1]!.role === "user" ? before[before.length - 1]! : null;
    return { answer, prompt, history: prompt ? before.slice(0, -1) : before };
  } catch (error: unknown) {
    logCaught("conversations.service.getAnswerWithPrompt", error);
    throw error;
  }
}

/** Merges `patch` into an assistant message's metadata (shallow, top-level keys). */
export async function mergeMessageMetadata(
  accountId: string,
  messageId: string,
  patch: AnswerMetadata
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE messages
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       WHERE id = $2::bigint AND account_id = $1 AND role = 'assistant'`,
      [accountId, messageId, JSON.stringify(patch)]
    );
  } catch (error: unknown) {
    logCaught("conversations.service.mergeMessageMetadata", error);
    throw error;
  }
}

/**
 * Compare: makes candidate `chosen` the message's answer (what later turns
 * see as context) and records the vote — one per answer, the latest wins.
 */
export async function chooseCandidate(input: {
  accountId: string;
  conversationId: string;
  message: MessageRow;
  chosen: number;
}): Promise<MessageRow | null> {
  const candidates = input.message.metadata?.candidates ?? [];
  const pick = candidates[input.chosen];
  if (!pick || pick.failed) return null;
  try {
    return await withPoolTransaction(async (client) => {
      const updated: QueryResult<MessageRow> = await client.query(
        `UPDATE messages
         SET content = $3, provider = $4,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('chosen', $5::int)
         WHERE id = $2::bigint AND account_id = $1 AND role = 'assistant'
         RETURNING ${MESSAGE_COLUMNS}`,
        [input.accountId, input.message.id, pick.content, pick.provider, input.chosen]
      );
      await client.query(
        `INSERT INTO answer_votes (account_id, conversation_id, message_id, task_type, winner_provider, loser_providers)
         VALUES ($1, $2, $3::bigint, $4, $5, $6)
         ON CONFLICT (account_id, message_id) DO UPDATE SET
           winner_provider = EXCLUDED.winner_provider,
           loser_providers = EXCLUDED.loser_providers,
           updated_at = now()`,
        [
          input.accountId,
          input.conversationId,
          input.message.id,
          input.message.task_type,
          pick.provider,
          candidates.filter((c, i) => i !== input.chosen && !c.failed).map((c) => c.provider),
        ]
      );
      return updated.rows[0] ?? null;
    });
  } catch (error: unknown) {
    logCaught("conversations.service.chooseCandidate", error);
    throw error;
  }
}
