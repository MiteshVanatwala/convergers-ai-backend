// In-memory client registry — POC stand-in for a real customers table.
// "demo" is the account the `web` playground actually bills against (see
// gateway/index.ts's DEMO_ACCOUNT_ID); anything else created here is
// admin-panel metadata with its own real credit balance in the ledger, but
// no live traffic routes to it yet — that needs per-client auth on the
// gateway, which this POC doesn't have.

export interface Client {
  id: string;
  name: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
  createdAt: Date;
}

export const PLANS = ["free", "pro", "enterprise"] as const;

const clients = new Map<string, Client>();

clients.set("demo", {
  id: "demo",
  name: "Demo / Playground",
  email: "demo@convergers.ai",
  plan: "free",
  createdAt: new Date(),
});

export function list(): Client[] {
  return [...clients.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function get(id: string): Client | undefined {
  return clients.get(id);
}

export function create(input: { name: string; email: string; plan: Client["plan"] }): Client {
  const id = crypto.randomUUID();
  const client: Client = { id, ...input, createdAt: new Date() };
  clients.set(id, client);
  return client;
}
