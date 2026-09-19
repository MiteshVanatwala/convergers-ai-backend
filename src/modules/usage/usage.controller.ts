import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { consumeRateLimit } from "../../infrastructure/http/rate-limit";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as usageService from "./usage.service";
import type { UsageOutcome } from "./usage.service";

const DEFAULT_RANGE_DAYS = 30;
const EXPORT_RATE_LIMIT = 10;
const EXPORT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

type UsageQuery = {
  from?: string;
  to?: string;
  provider?: string;
  task_type?: string;
  outcome?: string;
  limit?: string;
  cursor?: string;
};

function parseDate(raw: string | undefined, fallback: Date): Date | "invalid" {
  if (!raw || !raw.trim()) return fallback;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return "invalid";
  return d;
}

function parseRange(query: UsageQuery):
  | { from: Date; to: Date }
  | { error: string } {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  const from = parseDate(query.from, defaultFrom);
  const to = parseDate(query.to, now);
  if (from === "invalid" || to === "invalid") {
    return { error: "Invalid from/to date (use ISO-8601)" };
  }
  if (from.getTime() >= to.getTime()) {
    return { error: "`from` must be before `to`" };
  }
  return { from, to };
}

function parseOutcome(raw: string | undefined): UsageOutcome | null | "invalid" {
  if (!raw || !raw.trim()) return null;
  if (raw === "success" || raw === "error") return raw;
  return "invalid";
}

export async function listEvents(
  request: FastifyRequest<{ Querystring: UsageQuery }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;

  const range = parseRange(request.query);
  if ("error" in range) {
    return fail(reply, AppStatus.USAGE_VALIDATION_FAILED, range.error, 400);
  }

  const outcome = parseOutcome(request.query.outcome);
  if (outcome === "invalid") {
    return fail(reply, AppStatus.USAGE_VALIDATION_FAILED, "outcome must be success|error", 400);
  }

  const limitRaw = request.query.limit ? Number(request.query.limit) : 50;
  if (!Number.isFinite(limitRaw) || limitRaw < 1) {
    return fail(reply, AppStatus.USAGE_VALIDATION_FAILED, "limit must be a positive integer", 400);
  }

  try {
    const page = await usageService.listEvents({
      accountId: account.id,
      from: range.from,
      to: range.to,
      provider: request.query.provider?.trim() || null,
      taskType: request.query.task_type?.trim() || null,
      outcome,
      limit: limitRaw,
      cursor: request.query.cursor?.trim() || null,
    });
    return ok(reply, AppStatus.USAGE_EVENTS_RETRIEVED, page);
  } catch (error: unknown) {
    logCaught("usage.controller.listEvents", error);
    request.log.error({ err: error }, "[usage.controller.listEvents] failed");
    return fail(reply, AppStatus.USAGE_EVENTS_FETCH_FAILED, "Failed to load usage events", 500);
  }
}

export async function summary(
  request: FastifyRequest<{ Querystring: UsageQuery }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;

  const range = parseRange(request.query);
  if ("error" in range) {
    return fail(reply, AppStatus.USAGE_VALIDATION_FAILED, range.error, 400);
  }

  try {
    const data = await usageService.summarize({
      accountId: account.id,
      from: range.from,
      to: range.to,
    });
    return ok(reply, AppStatus.USAGE_SUMMARY_RETRIEVED, data);
  } catch (error: unknown) {
    logCaught("usage.controller.summary", error);
    request.log.error({ err: error }, "[usage.controller.summary] failed");
    return fail(reply, AppStatus.USAGE_SUMMARY_FETCH_FAILED, "Failed to load usage summary", 500);
  }
}

export async function exportCsv(
  request: FastifyRequest<{ Querystring: UsageQuery }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;

  const limited = consumeRateLimit(
    `usage-export:${account.id}`,
    EXPORT_RATE_LIMIT,
    EXPORT_WINDOW_MS
  );
  if (!limited.allowed) {
    reply.header("Retry-After", String(limited.retryAfterSec));
    return fail(
      reply,
      AppStatus.USAGE_EXPORT_RATE_LIMITED,
      "Too many usage exports — try again later",
      429
    );
  }

  const range = parseRange(request.query);
  if ("error" in range) {
    return fail(reply, AppStatus.USAGE_VALIDATION_FAILED, range.error, 400);
  }

  const outcome = parseOutcome(request.query.outcome);
  if (outcome === "invalid") {
    return fail(reply, AppStatus.USAGE_VALIDATION_FAILED, "outcome must be success|error", 400);
  }

  try {
    const rows = await usageService.listEventsForExport({
      accountId: account.id,
      from: range.from,
      to: range.to,
      provider: request.query.provider?.trim() || null,
      taskType: request.query.task_type?.trim() || null,
      outcome,
    });
    const csv = usageService.toCsv(rows);
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .status(200)
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="convergers-usage-${day}.csv"`)
      .send(csv);
  } catch (error: unknown) {
    logCaught("usage.controller.exportCsv", error);
    request.log.error({ err: error }, "[usage.controller.exportCsv] failed");
    return fail(reply, AppStatus.USAGE_EXPORT_FAILED, "Failed to export usage", 500);
  }
}
