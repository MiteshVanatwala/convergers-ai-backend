import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";
import type { FailureKind } from "./modelHealth";

const MESSAGE_MAX = 300;

/**
 * Saves why a model's API call failed (db/routing_costs_2026_10.sql), so the
 * admin dashboard can show what's pushing requests onto fallback models.
 * Fire-and-forget: never delays or fails the request that's falling back.
 */
export function recordModelCallFailure(input: {
  providerId: string;
  taskType: string;
  accountId: string | null;
  kind: FailureKind;
  status: number | null;
  error: unknown;
}): void {
  const raw = input.error instanceof Error ? input.error.message : String(input.error ?? "");
  const message = raw.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX) || null;
  void getPool()
    .query(
      `INSERT INTO model_call_failures (provider_id, task_type, account_id, kind, http_status, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.providerId, input.taskType, input.accountId, input.kind, input.status, message]
    )
    .catch((error: unknown) => logCaught("brain.callFailures.recordModelCallFailure", error));
}
