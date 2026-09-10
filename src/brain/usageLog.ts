// In-memory request log — POC stand-in for real analytics storage. Powers
// the admin dashboard's stats; the request path (router/index.ts) writes to
// it, nothing in the request path reads from it.

export interface UsageEvent {
  id: string;
  accountId: string;
  taskType: string;
  provider: string;
  outcome: "success" | "error";
  inputTokens: number;
  outputTokens: number;
  nativeCost: number;
  creditsCharged: number;
  fallbackUsed: boolean;
  createdAt: Date;
}

const MAX_EVENTS = 2000; // bounds memory growth for a long-running dev process

const events: UsageEvent[] = [];

export function record(event: Omit<UsageEvent, "id" | "createdAt">): void {
  events.push({ ...event, id: crypto.randomUUID(), createdAt: new Date() });
  if (events.length > MAX_EVENTS) events.shift();
}

export function recent(limit = 20): UsageEvent[] {
  return events.slice(-limit).reverse();
}

export interface UsageSummary {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalCreditsCharged: number;
  totalNativeCost: number;
  byProvider: { provider: string; count: number; creditsCharged: number }[];
  byTaskType: { taskType: string; count: number }[];
}

export function summary(): UsageSummary {
  const byProvider = new Map<string, { count: number; creditsCharged: number }>();
  const byTaskType = new Map<string, number>();
  let totalCreditsCharged = 0;
  let totalNativeCost = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const e of events) {
    if (e.outcome === "success") {
      successCount++;
      totalCreditsCharged += e.creditsCharged;
      totalNativeCost += e.nativeCost;
      const p = byProvider.get(e.provider) ?? { count: 0, creditsCharged: 0 };
      p.count++;
      p.creditsCharged += e.creditsCharged;
      byProvider.set(e.provider, p);
    } else {
      errorCount++;
    }
    byTaskType.set(e.taskType, (byTaskType.get(e.taskType) ?? 0) + 1);
  }

  return {
    totalRequests: events.length,
    successCount,
    errorCount,
    totalCreditsCharged,
    totalNativeCost,
    byProvider: [...byProvider.entries()].map(([provider, v]) => ({ provider, ...v })),
    byTaskType: [...byTaskType.entries()].map(([taskType, count]) => ({ taskType, count })),
  };
}
