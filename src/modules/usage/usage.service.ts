import type { PoolClient, QueryResult } from "pg";
import { LedgerReason, LedgerReferenceType } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { debit, ensureWallet } from "../ledger/ledger.service";
import { logCaught } from "../../shared/utils/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Queryable = PoolClient | ReturnType<typeof getPool>;

export type UsageOutcome = "success" | "error";

export type InsertUsageEventInput = {
  accountId: string;
  conversationId?: string | null;
  messageId?: string | null;
  taskType: string;
  provider: string;
  outcome: UsageOutcome;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  nativeCost?: number | null;
  creditsCharged?: number | null;
  fallbackUsed?: boolean;
  overrideUsed?: boolean;
};

export type UsageEventRecord = {
  id: string;
  createdAt: Date;
};

export type RecordSuccessAndDebitInput = {
  accountId: string;
  conversationId?: string | null;
  taskType: string;
  provider: string;
  tokensInput: number;
  tokensOutput: number;
  nativeCost: number;
  creditsRequested: number;
  fallbackUsed: boolean;
  overrideUsed?: boolean;
};

export type RecordSuccessAndDebitResult = {
  charged: number;
  balance: number;
  usageEventId: string | null;
};

export type ListUsageEventsInput = {
  accountId: string;
  from: Date;
  to: Date;
  provider?: string | null;
  taskType?: string | null;
  outcome?: UsageOutcome | null;
  limit: number;
  /** Opaque cursor: `${created_at.toISOString()}_${id}` */
  cursor?: string | null;
};

export type UsageEventListRow = {
  id: string;
  accountId: string;
  conversationId: string | null;
  messageId: string | null;
  taskType: string;
  provider: string;
  outcome: UsageOutcome;
  tokensInput: number | null;
  tokensOutput: number | null;
  nativeCost: number | null;
  creditsCharged: number | null;
  fallbackUsed: boolean;
  overrideUsed: boolean;
  createdAt: string;
};

export type UsageSummary = {
  from: string;
  to: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalCreditsCharged: number;
  totalNativeCost: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  byProvider: { provider: string; count: number; creditsCharged: number }[];
  byTaskType: { taskType: string; count: number; creditsCharged: number }[];
};

function isAccountUuid(accountId: string): boolean {
  return UUID_RE.test(accountId);
}

function asNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function asNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function runQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Queryable,
  text: string,
  params: unknown[]
): Promise<QueryResult<T>> {
  return db.query<T>(text, params);
}

/**
 * Insert a usage_events row. Skips DB for non-UUID (admin POC) account ids.
 * Uses privileged pool — RLS grants app_user SELECT only.
 */
export async function insertEvent(
  input: InsertUsageEventInput,
  client?: PoolClient
): Promise<UsageEventRecord | null> {
  try {
    if (!isAccountUuid(input.accountId)) return null;

    const db: Queryable = client ?? getPool();
    const result: QueryResult<{ id: string; created_at: Date }> = await runQuery(
      db,
      `INSERT INTO usage_events (
         account_id, conversation_id, message_id, task_type, provider, outcome,
         tokens_input, tokens_output, native_cost, credits_charged,
         fallback_used, override_used
       ) VALUES (
         $1::uuid, $2::uuid, $3::bigint, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12
       )
       RETURNING id::text AS id, created_at`,
      [
        input.accountId,
        input.conversationId ?? null,
        input.messageId ?? null,
        input.taskType,
        input.provider,
        input.outcome,
        input.tokensInput ?? null,
        input.tokensOutput ?? null,
        input.nativeCost ?? null,
        input.creditsCharged ?? null,
        input.fallbackUsed ?? false,
        input.overrideUsed ?? false,
      ]
    );

    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at };
  } catch (error: unknown) {
    logCaught("usage.service.insertEvent", error);
    throw error;
  }
}

/** Attach assistant message id (and conversation) after chat insert. */
export async function attachMessage(
  usageEventId: string,
  messageId: string,
  conversationId?: string | null
): Promise<void> {
  try {
    if (!/^\d+$/.test(usageEventId) || !/^\d+$/.test(messageId)) return;

    await getPool().query(
      `UPDATE usage_events
       SET message_id = $2::bigint,
           conversation_id = COALESCE($3::uuid, conversation_id)
       WHERE id = $1::bigint`,
      [usageEventId, messageId, conversationId ?? null]
    );
  } catch (error: unknown) {
    logCaught("usage.service.attachMessage", error);
    throw error;
  }
}

/**
 * One transaction: insert usage_events, debit wallet, ledger row with reference_id.
 * Zero charge → usage row only (no ledger row).
 */
export async function recordSuccessAndDebit(
  input: RecordSuccessAndDebitInput
): Promise<RecordSuccessAndDebitResult> {
  try {
    if (!isAccountUuid(input.accountId)) {
      const { charged, balance } = await debit(input.accountId, input.creditsRequested);
      return { charged, balance, usageEventId: null };
    }

    return await withPoolTransaction(async (client: PoolClient) => {
      await ensureWallet(input.accountId, client);

      const locked: QueryResult<{ balance: string }> = await runQuery(
        client,
        `SELECT balance FROM credit_wallets WHERE account_id = $1 FOR UPDATE`,
        [input.accountId]
      );
      const current = asNumber(locked.rows[0]?.balance ?? 0);
      const charged = Math.min(input.creditsRequested, current);
      const balance = current - charged;

      const event = await insertEvent(
        {
          accountId: input.accountId,
          conversationId: input.conversationId,
          taskType: input.taskType,
          provider: input.provider,
          outcome: "success",
          tokensInput: input.tokensInput,
          tokensOutput: input.tokensOutput,
          nativeCost: input.nativeCost,
          creditsCharged: charged,
          fallbackUsed: input.fallbackUsed,
          overrideUsed: input.overrideUsed ?? false,
        },
        client
      );

      if (charged > 0 && event) {
        await runQuery(
          client,
          `INSERT INTO credit_ledger (
             account_id, amount, reason, balance_after,
             reference_type, reference_id
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.accountId,
            -charged,
            LedgerReason.DEBIT,
            balance,
            LedgerReferenceType.USAGE_EVENT,
            event.id,
          ]
        );
        await runQuery(
          client,
          `UPDATE credit_wallets
           SET balance = $2, updated_at = now()
           WHERE account_id = $1`,
          [input.accountId, balance]
        );
      } else if (charged > 0 && !event) {
        // Should not happen for UUID accounts; fail closed.
        throw new Error("usage_events insert returned no row");
      }

      return {
        charged,
        balance,
        usageEventId: event?.id ?? null,
      };
    });
  } catch (error: unknown) {
    logCaught("usage.service.recordSuccessAndDebit", error);
    throw error;
  }
}

/** Persist an error / unconfigured outcome (no ledger debit). */
export async function recordErrorEvent(input: {
  accountId: string;
  conversationId?: string | null;
  taskType: string;
  provider: string;
}): Promise<UsageEventRecord | null> {
  return insertEvent({
    accountId: input.accountId,
    conversationId: input.conversationId,
    taskType: input.taskType,
    provider: input.provider,
    outcome: "error",
    tokensInput: 0,
    tokensOutput: 0,
    nativeCost: 0,
    creditsCharged: 0,
    fallbackUsed: false,
    overrideUsed: false,
  });
}

function parseCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf("_");
  if (sep <= 0) return null;
  const createdAtRaw = cursor.slice(0, sep);
  const id = cursor.slice(sep + 1);
  const createdAt = new Date(createdAtRaw);
  if (!Number.isFinite(createdAt.getTime()) || !/^\d+$/.test(id)) return null;
  return { createdAt, id };
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`;
}

type UsageDbRow = {
  id: string;
  account_id: string;
  conversation_id: string | null;
  message_id: string | null;
  task_type: string;
  provider: string;
  outcome: string;
  tokens_input: number | null;
  tokens_output: number | null;
  native_cost: string | number | null;
  credits_charged: string | number | null;
  fallback_used: boolean;
  override_used: boolean;
  created_at: Date;
};

function mapListRow(row: UsageDbRow): UsageEventListRow {
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    taskType: row.task_type,
    provider: row.provider,
    outcome: row.outcome === "error" ? "error" : "success",
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    nativeCost: asNumberOrNull(row.native_cost),
    creditsCharged: asNumberOrNull(row.credits_charged),
    fallbackUsed: row.fallback_used,
    overrideUsed: row.override_used,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listEvents(
  input: ListUsageEventsInput
): Promise<{ items: UsageEventListRow[]; nextCursor: string | null }> {
  try {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const cursor = parseCursor(input.cursor);

    const params: unknown[] = [
      input.accountId,
      input.from,
      input.to,
      input.provider ?? null,
      input.taskType ?? null,
      input.outcome ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ];

    const result: QueryResult<UsageDbRow> = await getPool().query(
      `SELECT id::text AS id,
              account_id::text AS account_id,
              conversation_id::text AS conversation_id,
              message_id::text AS message_id,
              task_type, provider, outcome,
              tokens_input, tokens_output, native_cost, credits_charged,
              fallback_used, override_used, created_at
       FROM usage_events
       WHERE account_id = $1::uuid
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz
         AND ($4::text IS NULL OR provider = $4)
         AND ($5::text IS NULL OR task_type = $5)
         AND ($6::text IS NULL OR outcome = $6)
         AND (
           $7::timestamptz IS NULL
           OR (created_at, id) < ($7::timestamptz, $8::bigint)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $9`,
      params
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(mapListRow);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.created_at, last.id) : null;

    return { items, nextCursor };
  } catch (error: unknown) {
    logCaught("usage.service.listEvents", error);
    throw error;
  }
}

export async function summarize(input: {
  accountId: string;
  from: Date;
  to: Date;
}): Promise<UsageSummary> {
  try {
    const totals: QueryResult<{
      total_requests: string;
      success_count: string;
      error_count: string;
      total_credits: string | null;
      total_native: string | null;
      total_tokens_in: string | null;
      total_tokens_out: string | null;
    }> = await getPool().query(
      `SELECT
         COUNT(*)::text AS total_requests,
         COUNT(*) FILTER (WHERE outcome = 'success')::text AS success_count,
         COUNT(*) FILTER (WHERE outcome = 'error')::text AS error_count,
         COALESCE(SUM(credits_charged) FILTER (WHERE outcome = 'success'), 0)::text AS total_credits,
         COALESCE(SUM(native_cost) FILTER (WHERE outcome = 'success'), 0)::text AS total_native,
         COALESCE(SUM(tokens_input), 0)::text AS total_tokens_in,
         COALESCE(SUM(tokens_output), 0)::text AS total_tokens_out
       FROM usage_events
       WHERE account_id = $1::uuid
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz`,
      [input.accountId, input.from, input.to]
    );

    const byProvider: QueryResult<{
      provider: string;
      count: string;
      credits_charged: string;
    }> = await getPool().query(
      `SELECT provider,
              COUNT(*)::text AS count,
              COALESCE(SUM(credits_charged) FILTER (WHERE outcome = 'success'), 0)::text AS credits_charged
       FROM usage_events
       WHERE account_id = $1::uuid
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz
       GROUP BY provider
       ORDER BY COUNT(*) DESC, provider ASC`,
      [input.accountId, input.from, input.to]
    );

    const byTaskType: QueryResult<{
      task_type: string;
      count: string;
      credits_charged: string;
    }> = await getPool().query(
      `SELECT task_type,
              COUNT(*)::text AS count,
              COALESCE(SUM(credits_charged) FILTER (WHERE outcome = 'success'), 0)::text AS credits_charged
       FROM usage_events
       WHERE account_id = $1::uuid
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz
       GROUP BY task_type
       ORDER BY COUNT(*) DESC, task_type ASC`,
      [input.accountId, input.from, input.to]
    );

    const t = totals.rows[0];
    return {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      totalRequests: Number(t?.total_requests ?? 0),
      successCount: Number(t?.success_count ?? 0),
      errorCount: Number(t?.error_count ?? 0),
      totalCreditsCharged: asNumber(t?.total_credits),
      totalNativeCost: asNumber(t?.total_native),
      totalTokensInput: asNumber(t?.total_tokens_in),
      totalTokensOutput: asNumber(t?.total_tokens_out),
      byProvider: byProvider.rows.map((r) => ({
        provider: r.provider,
        count: Number(r.count),
        creditsCharged: asNumber(r.credits_charged),
      })),
      byTaskType: byTaskType.rows.map((r) => ({
        taskType: r.task_type,
        count: Number(r.count),
        creditsCharged: asNumber(r.credits_charged),
      })),
    };
  } catch (error: unknown) {
    logCaught("usage.service.summarize", error);
    throw error;
  }
}

const EXPORT_MAX_ROWS = 10_000;

/** Rows for CSV export (hard-capped). */
export async function listEventsForExport(input: {
  accountId: string;
  from: Date;
  to: Date;
  provider?: string | null;
  taskType?: string | null;
  outcome?: UsageOutcome | null;
}): Promise<UsageEventListRow[]> {
  try {
    const result: QueryResult<UsageDbRow> = await getPool().query(
      `SELECT id::text AS id,
              account_id::text AS account_id,
              conversation_id::text AS conversation_id,
              message_id::text AS message_id,
              task_type, provider, outcome,
              tokens_input, tokens_output, native_cost, credits_charged,
              fallback_used, override_used, created_at
       FROM usage_events
       WHERE account_id = $1::uuid
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz
         AND ($4::text IS NULL OR provider = $4)
         AND ($5::text IS NULL OR task_type = $5)
         AND ($6::text IS NULL OR outcome = $6)
       ORDER BY created_at DESC, id DESC
       LIMIT $7`,
      [
        input.accountId,
        input.from,
        input.to,
        input.provider ?? null,
        input.taskType ?? null,
        input.outcome ?? null,
        EXPORT_MAX_ROWS,
      ]
    );
    return result.rows.map(mapListRow);
  } catch (error: unknown) {
    logCaught("usage.service.listEventsForExport", error);
    throw error;
  }
}

export function toCsv(rows: UsageEventListRow[]): string {
  const header = [
    "id",
    "created_at",
    "task_type",
    "provider",
    "outcome",
    "tokens_input",
    "tokens_output",
    "native_cost",
    "credits_charged",
    "fallback_used",
    "conversation_id",
    "message_id",
  ];
  const escape = (v: string | number | boolean | null): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.createdAt,
        r.taskType,
        r.provider,
        r.outcome,
        r.tokensInput,
        r.tokensOutput,
        r.nativeCost,
        r.creditsCharged,
        r.fallbackUsed,
        r.conversationId,
        r.messageId,
      ]
        .map(escape)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export { EXPORT_MAX_ROWS };
