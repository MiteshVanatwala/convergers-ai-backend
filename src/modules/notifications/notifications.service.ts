import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { logCaught } from "../../shared/utils/log";

export type Recipient = { email: string; name: string | null };

export async function getAccountRecipient(accountId: string): Promise<Recipient | null> {
  try {
    const result: QueryResult<Recipient> = await getPool().query(
      `SELECT email, name FROM accounts WHERE id = $1`,
      [accountId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("notifications.service.getAccountRecipient", error);
    throw error;
  }
}

/** The org's owner (who bought Team) and the org's name. */
export async function getOrgOwnerRecipient(
  orgId: string
): Promise<(Recipient & { orgName: string }) | null> {
  try {
    const result: QueryResult<Recipient & { org_name: string }> = await getPool().query(
      `SELECT a.email, a.name, o.name AS org_name
       FROM organizations o
       JOIN accounts a ON a.id = o.owner_id
       WHERE o.id = $1`,
      [orgId]
    );
    const row = result.rows[0];
    return row ? { email: row.email, name: row.name, orgName: row.org_name } : null;
  } catch (error: unknown) {
    logCaught("notifications.service.getOrgOwnerRecipient", error);
    throw error;
  }
}

export async function getPlanDisplayName(planKey: string): Promise<string> {
  try {
    const result: QueryResult<{ display_name: string }> = await getPool().query(
      `SELECT display_name FROM plans WHERE key = $1`,
      [planKey]
    );
    return result.rows[0]?.display_name ?? planKey;
  } catch (error: unknown) {
    logCaught("notifications.service.getPlanDisplayName", error);
    throw error;
  }
}
