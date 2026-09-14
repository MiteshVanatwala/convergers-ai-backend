// In-memory client registry — POC stand-in for a real customers table.
// "demo" is the account the web playground bills against until per-user auth billing lands.

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

export function listClients(): Client[] {
  return [...clients.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function getClient(id: string): Client | undefined {
  return clients.get(id);
}

export function createClient(input: { name: string; email: string; plan: Client["plan"] }): Client {
  const id = crypto.randomUUID();
  const client: Client = { id, ...input, createdAt: new Date() };
  clients.set(id, client);
  return client;
}
