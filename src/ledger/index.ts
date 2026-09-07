// Credit ledger: double-entry, append-only per the technical plan §06.
// Placeholder — not wired to Postgres yet.

export interface LedgerEntry {
  accountId: string;
  amount: number;
  reason: "debit" | "refund" | "purchase" | "reversal";
  createdAt: Date;
}

export async function debit(_accountId: string, _credits: number): Promise<void> {
  throw new Error("ledger.debit not implemented yet");
}
