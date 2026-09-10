// Credit ledger — POC in-memory stand-in for the double-entry, append-only
// ledger described in the technical plan §06. Balances live in process
// memory only and reset on restart; swap this module for the Postgres-backed
// one before this leaves POC.

export interface LedgerEntry {
  accountId: string;
  amount: number;
  reason: "debit" | "refund" | "purchase" | "reversal";
  createdAt: Date;
}

const STARTING_CREDITS = Number(process.env.DEMO_STARTING_CREDITS ?? 100_000);
// 1 credit = $0.001 of provider cost — an arbitrary POC markup; the real
// number is a pricing decision, not an engineering one.
const CREDITS_PER_USD = 1000;

const balances = new Map<string, number>();
const entries: LedgerEntry[] = [];

function accountBalance(accountId: string): number {
  if (!balances.has(accountId)) balances.set(accountId, STARTING_CREDITS);
  return balances.get(accountId)!;
}

export function getBalance(accountId: string): number {
  return accountBalance(accountId);
}

export function creditsForCost(nativeCostUsd: number): number {
  return Math.max(1, Math.ceil(nativeCostUsd * CREDITS_PER_USD));
}

/**
 * Debits up to `credits` from the account, clamping at zero. POC
 * simplification: a real ledger would reserve/reject pre-flight instead of
 * letting the balance run out only after the provider call already ran.
 */
export async function debit(
  accountId: string,
  credits: number
): Promise<{ charged: number; balance: number }> {
  const current = accountBalance(accountId);
  const charged = Math.min(credits, current);
  const balance = current - charged;
  balances.set(accountId, balance);
  entries.push({ accountId, amount: -charged, reason: "debit", createdAt: new Date() });
  return { charged, balance };
}
