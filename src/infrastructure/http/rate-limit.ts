/**
 * In-process sliding-window rate limiter for admin routes.
 * Per-process only — replace with Redis when running multiple API replicas.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

type WindowState = {
  hits: number[];
};

const windows = new Map<string, WindowState>();

function prune(hits: number[], windowStart: number): number[] {
  return hits.filter((t) => t >= windowStart);
}

/**
 * Record a hit for `key` in a sliding window.
 * `limit` max hits per `windowMs`.
 */
export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number = Date.now()
): RateLimitResult {
  const windowStart = nowMs - windowMs;
  const state = windows.get(key) ?? { hits: [] };
  state.hits = prune(state.hits, windowStart);

  if (state.hits.length >= limit) {
    windows.set(key, state);
    const oldest = state.hits[0] ?? nowMs;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  state.hits.push(nowMs);
  windows.set(key, state);
  return {
    allowed: true,
    remaining: Math.max(0, limit - state.hits.length),
    retryAfterSec: 0,
  };
}

/** Test / ops helper — clears all buckets. */
export function resetRateLimitStore(): void {
  windows.clear();
}
