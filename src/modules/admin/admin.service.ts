// Admin data access — POC wraps in-memory store + brain usage log / key store.
// Replace bodies with SQL when Postgres admin entities land; keep this as the
// single data API for the admin controller.

import {
  PROVIDERS,
  getKey,
  setKey,
  isConfigured,
  maskKey,
  keySource,
} from "../brain/adapters/keyStore";
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

export function listProviders() {
  return PROVIDERS.map((p) => {
    const key = getKey(p.id);
    return {
      id: p.id,
      label: p.label,
      envVar: p.envVar,
      configured: isConfigured(p.id),
      source: keySource(p.id),
      maskedKey: key ? maskKey(key) : null,
    };
  });
}

export function setProviderKey(id: string, apiKey: string): { ok: true } | { error: "unknown_provider" } {
  if (!PROVIDERS.some((p) => p.id === id)) {
    return { error: "unknown_provider" };
  }
  setKey(id, apiKey);
  return { ok: true };
}

export function maskProviderKey(apiKey: string): string {
  return maskKey(apiKey);
}

export { PLANS } from "./clients.store";
export type { Client } from "./clients.store";
