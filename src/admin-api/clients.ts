// In-memory client registry — POC stand-in for a real customers table.
// "demo" is the account the `web` playground actually bills against (see
// gateway/index.ts's DEMO_ACCOUNT_ID); anything else created here is
// admin-panel metadata with its own real credit balance in the ledger, but
// no live traffic routes to it yet — that needs per-client auth on the
// gateway, which this POC doesn't have.

// Plan slugs match the product plan's billing tiers (pay-as-you-go / growth
// / scale), not a generic free/pro/enterprise SaaS ladder — this product
// bills by credits, and these names describe how, not a feature gate.
// "Free" isn't a fourth plan: a brand-new pay_as_you_go account simply
// hasn't bought a pack yet.
export interface Client {
  id: string;
  name: string;
  email: string;
  plan: "pay_as_you_go" | "growth" | "scale";
  createdAt: Date;
}

export const PLANS = ["pay_as_you_go", "growth", "scale"] as const;

const clients = new Map<string, Client>();

clients.set("demo", {
  id: "demo",
  name: "Demo / Playground",
  email: "demo@convergers.ai",
  plan: "pay_as_you_go",
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
