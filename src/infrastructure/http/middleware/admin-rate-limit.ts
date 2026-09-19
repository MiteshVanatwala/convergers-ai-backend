import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../../config/app-status-codes";
import { loadEnv } from "../../../config/env";
import { fail } from "../../../shared/http/api-response";
import { consumeRateLimit } from "../rate-limit";

const WINDOW_MS = 60_000;

function clientIp(request: FastifyRequest): string {
  const forwardedFor: string | string[] | undefined = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0]!.trim();
  }
  return request.ip || "unknown";
}

function applyLimit(
  reply: FastifyReply,
  bucketKey: string,
  limit: number
): boolean {
  const result = consumeRateLimit(bucketKey, limit, WINDOW_MS);
  reply.header("X-RateLimit-Limit", String(limit));
  reply.header("X-RateLimit-Remaining", String(result.remaining));
  if (!result.allowed) {
    reply.header("Retry-After", String(result.retryAfterSec));
    fail(reply, AppStatus.ADMIN_RATE_LIMITED, "Too many requests. Try again shortly.", 429);
    return false;
  }
  return true;
}

/** Strict limit on public admin login (keyed by client IP). */
export async function requireAdminLoginRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const limit = loadEnv().adminLoginRateLimitPerMin;
  if (!applyLimit(reply, `admin-login:${clientIp(request)}`, limit)) return;
}

/**
 * Limit admin operators list/read traffic (keyed by admin id when present, else IP).
 * Runs after requireAdmin so request.admin is usually set.
 */
export async function requireAdminOperatorsReadRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const limit = loadEnv().adminOperatorsReadRateLimitPerMin;
  const id = request.admin?.id ?? clientIp(request);
  if (!applyLimit(reply, `admin-operators-read:${id}`, limit)) return;
}

/** Limit admin operators mutations (create / patch / deactivate / reset). */
export async function requireAdminOperatorsMutationRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const limit = loadEnv().adminOperatorsMutationRateLimitPerMin;
  const id = request.admin?.id ?? clientIp(request);
  if (!applyLimit(reply, `admin-operators-mutate:${id}`, limit)) return;
}
