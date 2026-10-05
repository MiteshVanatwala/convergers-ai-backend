/**
 * Live per-model health, from every call the router makes — including
 * attempts that failed and fell back to another model, which usage_events
 * never sees (it records the model that finally answered).
 *
 * In memory on purpose: it answers "is this model working right now?", so
 * losing it on restart is fine (it refills with the next requests). History
 * lives in usage_events.
 */

export type FailureKind = "rate_limited" | "auth" | "account" | "error";

type Attempt = { at: number; ok: boolean; latencyMs: number; kind?: FailureKind };

type ModelState = {
  attempts: Attempt[];
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailure: { kind: FailureKind; status: number | null } | null;
};

const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 500;
const states = new Map<string, ModelState>();

function stateFor(modelId: string): ModelState {
  let s = states.get(modelId);
  if (!s) {
    s = { attempts: [], lastSuccessAt: null, lastFailureAt: null, lastFailure: null };
    states.set(modelId, s);
  }
  return s;
}

function push(s: ModelState, a: Attempt) {
  s.attempts.push(a);
  const cutoff = a.at - WINDOW_MS;
  while (s.attempts.length > MAX_ATTEMPTS || (s.attempts[0] && s.attempts[0].at < cutoff)) s.attempts.shift();
}

export function recordModelSuccess(modelId: string, latencyMs: number): void {
  const s = stateFor(modelId);
  const at = Date.now();
  push(s, { at, ok: true, latencyMs });
  s.lastSuccessAt = at;
}

export function recordModelFailure(modelId: string, latencyMs: number, kind: FailureKind, status: number | null): void {
  const s = stateFor(modelId);
  const at = Date.now();
  push(s, { at, ok: false, latencyMs, kind });
  s.lastFailureAt = at;
  s.lastFailure = { kind, status };
}

export type ModelHealthStats = {
  /** Attempts in the last 15 minutes. */
  attempts15m: number;
  failures15m: number;
  rateLimited15m: number;
  /** Attempts in the last hour. */
  attempts1h: number;
  failures1h: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: { kind: FailureKind; status: number | null } | null;
  /** True when the most recent attempt failed. */
  lastAttemptFailed: boolean;
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export function getModelHealth(modelId: string): ModelHealthStats {
  const s = states.get(modelId);
  const now = Date.now();
  const inHour = s ? s.attempts.filter((a) => a.at >= now - WINDOW_MS) : [];
  const in15 = inHour.filter((a) => a.at >= now - 15 * 60 * 1000);
  // Latency of successful calls only — a fast 429 shouldn't look like a fast model.
  const latencies = inHour.filter((a) => a.ok).map((a) => a.latencyMs).sort((a, b) => a - b);
  return {
    attempts15m: in15.length,
    failures15m: in15.filter((a) => !a.ok).length,
    rateLimited15m: in15.filter((a) => a.kind === "rate_limited").length,
    attempts1h: inHour.length,
    failures1h: inHour.filter((a) => !a.ok).length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    lastSuccessAt: s?.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
    lastFailureAt: s?.lastFailureAt ? new Date(s.lastFailureAt).toISOString() : null,
    lastFailure: s?.lastFailure ?? null,
    lastAttemptFailed: Boolean(s && s.attempts.length > 0 && !s.attempts[s.attempts.length - 1]!.ok),
  };
}
