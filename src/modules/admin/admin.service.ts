// Admin data access — POC wraps in-memory store + brain usage log.
// Replace bodies with SQL when Postgres admin entities land; keep this as the
// single data API for the admin controller. Provider/credential data access
// lives in admin-providers.service.ts.

import * as usageLog from "../brain/usageLog";
import { getBalance } from "../ledger/ledger.service";
import * as clientsStore from "./clients.store";
import type { Client } from "./clients.store";

export async function listClientsWithBalances() {
  const clients = clientsStore.listClients();
  return Promise.all(
    clients.map(async (client) => ({
      ...client,
      creditBalance: await getBalance(client.id),
    }))
  );
}

export async function createClient(input: { name: string; email: string; plan: Client["plan"] }) {
  const client = clientsStore.createClient(input);
  return { ...client, creditBalance: await getBalance(client.id) };
}

export function getStats() {
  return {
    ...usageLog.summary(),
    recent: usageLog.recent(10),
  };
}

export { PLANS } from "./clients.store";
export type { Client } from "./clients.store";
