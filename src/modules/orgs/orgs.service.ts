import type { PoolClient, QueryResult } from "pg";
import { LedgerReason } from "../../config/ledger-reasons";
import { getPool } from "../../infrastructure/db/pool";
import { withPoolTransaction } from "../../infrastructure/db/with-transaction";
import { logCaught } from "../../shared/utils/log";
import type { InvitableRole, OrgRole } from "./orgs.permissions";

export type OrgErrorKind =
  | "already_member"
  | "already_invited"
  | "invite_not_found"
  | "invite_expired"
  | "invite_wrong_account"
  | "no_seats"
  | "org_not_found"
  | "not_set_up"
  | "has_plan"
  | "has_history";

export class OrgError extends Error {
  constructor(
    message: string,
    readonly kind: OrgErrorKind
  ) {
    super(message);
    this.name = "OrgError";
  }
}

const NAME_MAX = 80;
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === UNIQUE_VIOLATION
  );
}

export function normalizeOrgName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

export type OrgRow = {
  id: string;
  name: string;
  owner_id: string;
  enforce_sensitive_filter: boolean;
  allowed_model_ids: string[] | null;
  seats: number;
  created_at: Date;
};

export type MemberRow = {
  account_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: OrgRole;
  monthly_credit_limit: number | null;
  joined_at: Date | null;
};

export type InviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: InvitableRole;
  invited_by: string;
  created_at: Date;
  expires_at: Date;
};

export type PendingInviteRow = InviteRow & { org_name: string; inviter_name: string | null; inviter_email: string };

const OPEN_INVITE = `accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;

export async function getMembership(
  accountId: string
): Promise<{ orgId: string; role: OrgRole } | null> {
  try {
    const result: QueryResult<{ org_id: string; role: OrgRole }> = await getPool().query(
      `SELECT org_id::text AS org_id, role FROM organization_members WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    return row ? { orgId: row.org_id, role: row.role } : null;
  } catch (error: unknown) {
    logCaught("orgs.service.getMembership", error);
    throw error;
  }
}

export async function getOrg(orgId: string): Promise<OrgRow | null> {
  try {
    const result: QueryResult<OrgRow> = await getPool().query(
      `SELECT id::text AS id, name, owner_id::text AS owner_id, enforce_sensitive_filter,
              allowed_model_ids, seats, created_at
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    return result.rows[0] ?? null;
  } catch (error: unknown) {
    logCaught("orgs.service.getOrg", error);
    throw error;
  }
}

export async function getPoolBalance(orgId: string): Promise<number> {
  try {
    const result: QueryResult<{ balance: string }> = await getPool().query(
      `SELECT balance FROM org_credit_wallets WHERE org_id = $1`,
      [orgId]
    );
    return Number(result.rows[0]?.balance ?? 0);
  } catch (error: unknown) {
    logCaught("orgs.service.getPoolBalance", error);
    throw error;
  }
}

export type OrgPolicy = {
  orgId: string;
  orgName: string;
  role: OrgRole;
  enforceSensitiveFilter: boolean;
  /** null = every model the plan allows. */
  allowedModelIds: string[] | null;
  /** The org's paid plan ("team"), or null without one. */
  planKey: string | null;
};

/** The org rules that apply to this account's requests, or null when not in an org. */
export async function getOrgPolicyForAccount(accountId: string): Promise<OrgPolicy | null> {
  try {
    const result: QueryResult<{
      org_id: string;
      name: string;
      role: OrgRole;
      enforce_sensitive_filter: boolean;
      allowed_model_ids: string[] | null;
      plan_key: string | null;
    }> = await getPool().query(
      `SELECT o.id::text AS org_id, o.name, m.role, o.enforce_sensitive_filter, o.allowed_model_ids,
              p.key AS plan_key
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
       LEFT JOIN plans p ON p.id = o.plan_id
       WHERE m.account_id::text = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      orgId: row.org_id,
      orgName: row.name,
      role: row.role,
      enforceSensitiveFilter: row.enforce_sensitive_filter,
      allowedModelIds: row.allowed_model_ids,
      planKey: row.plan_key,
    };
  } catch (error: unknown) {
    logCaught("orgs.service.getOrgPolicyForAccount", error);
    throw error;
  }
}

export async function updateOrgSettings(
  orgId: string,
  input: { enforceSensitiveFilter?: boolean; allowedModelIds?: string[] | null }
): Promise<void> {
  try {
    const sets: string[] = [];
    const params: unknown[] = [orgId];
    if (input.enforceSensitiveFilter !== undefined) {
      params.push(input.enforceSensitiveFilter);
      sets.push(`enforce_sensitive_filter = $${params.length}`);
    }
    if (input.allowedModelIds !== undefined) {
      params.push(input.allowedModelIds);
      sets.push(`allowed_model_ids = $${params.length}::text[]`);
    }
    if (sets.length === 0) return;
    await getPool().query(
      `UPDATE organizations SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
      params
    );
  } catch (error: unknown) {
    logCaught("orgs.service.updateOrgSettings", error);
    throw error;
  }
}

export async function setMemberCreditLimit(
  orgId: string,
  accountId: string,
  monthlyCreditLimit: number | null
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE organization_members SET monthly_credit_limit = $3 WHERE org_id = $1 AND account_id = $2`,
      [orgId, accountId, monthlyCreditLimit]
    );
  } catch (error: unknown) {
    logCaught("orgs.service.setMemberCreditLimit", error);
    throw error;
  }
}

/** Credits each member spent from the pool this calendar month, keyed by account id. */
export async function getMemberSpendThisMonth(orgId: string): Promise<Map<string, number>> {
  try {
    const result: QueryResult<{ account_id: string; spent: string }> = await getPool().query(
      `SELECT account_id::text AS account_id, (-SUM(amount))::text AS spent
       FROM credit_ledger
       WHERE org_id = $1 AND reason = $2 AND created_at >= date_trunc('month', now())
       GROUP BY account_id`,
      [orgId, LedgerReason.DEBIT]
    );
    return new Map(result.rows.map((r) => [r.account_id, Number(r.spent)]));
  } catch (error: unknown) {
    logCaught("orgs.service.getMemberSpendThisMonth", error);
    throw error;
  }
}

/** The org's most recent Team subscription (excluding never-completed checkouts), or null. */
export async function getOrgSubscription(
  orgId: string
): Promise<{
  status: string;
  seats: number;
  /** A seat decrease scheduled for the end of the billing cycle, if any. */
  pendingSeats: number | null;
  currentPeriodEnd: Date | null;
} | null> {
  try {
    const result: QueryResult<{
      status: string;
      quantity: number;
      pending_quantity: number | null;
      current_period_end: Date | null;
    }> = await getPool().query(
      `SELECT status, quantity, pending_quantity, current_period_end
       FROM subscriptions
       WHERE org_id = $1 AND status <> 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    const row = result.rows[0];
    return row
      ? {
          status: row.status,
          seats: row.quantity,
          pendingSeats: row.pending_quantity,
          currentPeriodEnd: row.current_period_end,
        }
      : null;
  } catch (error: unknown) {
    logCaught("orgs.service.getOrgSubscription", error);
    throw error;
  }
}

/** Seats taken: members plus open invites (an invite reserves a seat until it expires or is revoked). */
export async function countSeatsUsed(orgId: string, db: PoolClient | ReturnType<typeof getPool> = getPool()): Promise<number> {
  try {
    const result: QueryResult<{ used: string }> = await db.query(
      `SELECT ((SELECT COUNT(*) FROM organization_members WHERE org_id = $1)
             + (SELECT COUNT(*) FROM org_invites
                WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
              )::text AS used`,
      [orgId]
    );
    return Number(result.rows[0]?.used ?? 0);
  } catch (error: unknown) {
    logCaught("orgs.service.countSeatsUsed", error);
    throw error;
  }
}

export type OrgUsageReport = {
  from: string;
  to: string;
  totals: { requests: number; failed: number; credits: number; tokens: number };
  byMember: { accountId: string; email: string; name: string | null; requests: number; credits: number }[];
  byModel: { provider: string; requests: number; credits: number }[];
  masking: {
    /** Requests in which at least one value was masked. */
    requests: number;
    /** Distinct values masked across those requests. */
    values: number;
    /** Requests in which each kind was masked. */
    byType: { type: string; requests: number }[];
  };
};

/** Usage charged to the org pool in [from, to) — only requests made as a member (usage_events.org_id). */
export async function getOrgUsage(orgId: string, from: Date, to: Date): Promise<OrgUsageReport> {
  try {
    const pool = getPool();
    const range = [orgId, from, to];
    const where = `org_id = $1 AND created_at >= $2 AND created_at < $3`;

    const [totals, byMember, byModel, masking, maskTypes] = await Promise.all([
      pool.query<{ requests: string; failed: string; credits: string; tokens: string }>(
        `SELECT COUNT(*)::text AS requests,
                COUNT(*) FILTER (WHERE outcome = 'error')::text AS failed,
                COALESCE(SUM(credits_charged), 0)::text AS credits,
                COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)), 0)::text AS tokens
         FROM usage_events WHERE ${where}`,
        range
      ),
      pool.query<{ account_id: string; email: string; name: string | null; requests: string; credits: string }>(
        `SELECT u.account_id::text AS account_id, a.email, a.name,
                COUNT(*)::text AS requests, COALESCE(SUM(u.credits_charged), 0)::text AS credits
         FROM usage_events u JOIN accounts a ON a.id = u.account_id
         WHERE u.org_id = $1 AND u.created_at >= $2 AND u.created_at < $3
         GROUP BY u.account_id, a.email, a.name
         ORDER BY SUM(u.credits_charged) DESC NULLS LAST, COUNT(*) DESC`,
        range
      ),
      pool.query<{ provider: string; requests: string; credits: string }>(
        `SELECT provider, COUNT(*)::text AS requests, COALESCE(SUM(credits_charged), 0)::text AS credits
         FROM usage_events WHERE ${where}
         GROUP BY provider ORDER BY COUNT(*) DESC`,
        range
      ),
      pool.query<{ requests: string; values: string }>(
        `SELECT COUNT(*) FILTER (WHERE redacted_count > 0)::text AS requests,
                COALESCE(SUM(redacted_count), 0)::text AS values
         FROM usage_events WHERE ${where}`,
        range
      ),
      pool.query<{ type: string; requests: string }>(
        `SELECT t.type, COUNT(*)::text AS requests
         FROM usage_events, unnest(redacted_types) AS t(type)
         WHERE ${where}
         GROUP BY t.type ORDER BY COUNT(*) DESC`,
        range
      ),
    ]);

    const t = totals.rows[0];
    const m = masking.rows[0];
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        requests: Number(t?.requests ?? 0),
        failed: Number(t?.failed ?? 0),
        credits: Number(t?.credits ?? 0),
        tokens: Number(t?.tokens ?? 0),
      },
      byMember: byMember.rows.map((r) => ({
        accountId: r.account_id,
        email: r.email,
        name: r.name,
        requests: Number(r.requests),
        credits: Number(r.credits),
      })),
      byModel: byModel.rows.map((r) => ({
        provider: r.provider,
        requests: Number(r.requests),
        credits: Number(r.credits),
      })),
      masking: {
        requests: Number(m?.requests ?? 0),
        values: Number(m?.values ?? 0),
        byType: maskTypes.rows.map((r) => ({ type: r.type, requests: Number(r.requests) })),
      },
    };
  } catch (error: unknown) {
    logCaught("orgs.service.getOrgUsage", error);
    throw error;
  }
}

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  try {
    const result: QueryResult<MemberRow> = await getPool().query(
      `SELECT a.id::text AS account_id, a.email, a.name, a.avatar_url, m.role,
              m.monthly_credit_limit, m.joined_at
       FROM organization_members m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.org_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(a.email)`,
      [orgId]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("orgs.service.listMembers", error);
    throw error;
  }
}

export async function listOpenInvites(orgId: string): Promise<InviteRow[]> {
  try {
    const result: QueryResult<InviteRow> = await getPool().query(
      `SELECT id::text AS id, org_id::text AS org_id, email, role, invited_by::text AS invited_by,
              created_at, expires_at
       FROM org_invites
       WHERE org_id = $1 AND ${OPEN_INVITE}
       ORDER BY created_at DESC`,
      [orgId]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("orgs.service.listOpenInvites", error);
    throw error;
  }
}

export async function listPendingInvitesForEmail(email: string): Promise<PendingInviteRow[]> {
  try {
    const result: QueryResult<PendingInviteRow> = await getPool().query(
      `SELECT i.id::text AS id, i.org_id::text AS org_id, i.email, i.role,
              i.invited_by::text AS invited_by, i.created_at, i.expires_at,
              o.name AS org_name, a.name AS inviter_name, a.email AS inviter_email
       FROM org_invites i
       JOIN organizations o ON o.id = i.org_id
       JOIN accounts a ON a.id = i.invited_by
       WHERE i.email = $1
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       ORDER BY i.created_at DESC`,
      [email]
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("orgs.service.listPendingInvitesForEmail", error);
    throw error;
  }
}

export async function isEmailMember(orgId: string, email: string): Promise<boolean> {
  try {
    const result = await getPool().query(
      `SELECT 1 FROM organization_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.org_id = $1 AND a.email = $2`,
      [orgId, email]
    );
    return result.rows.length > 0;
  } catch (error: unknown) {
    logCaught("orgs.service.isEmailMember", error);
    throw error;
  }
}

/** Creates the org with the caller as owner, plus its (empty) shared credit pool. */
export async function createOrg(accountId: string, name: string): Promise<OrgRow> {
  try {
    return await withPoolTransaction(async (client: PoolClient) => {
      const created: QueryResult<OrgRow> = await client.query(
        `INSERT INTO organizations (name, owner_id)
         VALUES ($1, $2)
         RETURNING id::text AS id, name, owner_id::text AS owner_id, enforce_sensitive_filter,
                   allowed_model_ids, seats, created_at`,
        [name, accountId]
      );
      const org = created.rows[0];
      if (!org) throw new Error("organizations insert returned no row");
      await client.query(
        `INSERT INTO organization_members (org_id, account_id, role, joined_at)
         VALUES ($1, $2, 'owner', now())`,
        [org.id, accountId]
      );
      await client.query(`INSERT INTO org_credit_wallets (org_id) VALUES ($1)`, [org.id]);
      return org;
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new OrgError("You're already in an organization.", "already_member");
    }
    logCaught("orgs.service.createOrg", error);
    throw error;
  }
}

export async function renameOrg(orgId: string, name: string): Promise<void> {
  try {
    await getPool().query(`UPDATE organizations SET name = $2, updated_at = now() WHERE id = $1`, [
      orgId,
      name,
    ]);
  } catch (error: unknown) {
    logCaught("orgs.service.renameOrg", error);
    throw error;
  }
}

export async function createInvite(input: {
  orgId: string;
  email: string;
  role: InvitableRole;
  invitedBy: string;
}): Promise<InviteRow> {
  try {
    const result: QueryResult<InviteRow> = await getPool().query(
      `INSERT INTO org_invites (org_id, email, role, invited_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text AS id, org_id::text AS org_id, email, role,
                 invited_by::text AS invited_by, created_at, expires_at`,
      [input.orgId, input.email, input.role, input.invitedBy]
    );
    const row = result.rows[0];
    if (!row) throw new Error("org_invites insert returned no row");
    return row;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new OrgError("That address already has a pending invite.", "already_invited");
    }
    logCaught("orgs.service.createInvite", error);
    throw error;
  }
}

/** Revokes an open invite of this org; false if there was none. */
export async function revokeInvite(orgId: string, inviteId: string): Promise<boolean> {
  try {
    const result = await getPool().query(
      `UPDATE org_invites SET revoked_at = now()
       WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [inviteId, orgId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("orgs.service.revokeInvite", error);
    throw error;
  }
}

/**
 * Joins the invitee to the org. The invite row is locked so a double-click
 * can't accept twice; the one-org-per-account unique index rejects joining
 * while already in an org.
 */
export async function acceptInvite(input: {
  inviteId: string;
  accountId: string;
  email: string;
}): Promise<{ orgId: string }> {
  try {
    return await withPoolTransaction(async (client: PoolClient) => {
      const locked: QueryResult<{
        org_id: string;
        email: string;
        role: InvitableRole;
        expired: boolean;
        open: boolean;
      }> = await client.query(
        `SELECT org_id::text AS org_id, email, role,
                expires_at <= now() AS expired,
                accepted_at IS NULL AND revoked_at IS NULL AS open
         FROM org_invites WHERE id = $1 FOR UPDATE`,
        [input.inviteId]
      );
      const invite = locked.rows[0];
      if (!invite || !invite.open) {
        throw new OrgError("This invite is no longer available.", "invite_not_found");
      }
      if (invite.email.toLowerCase() !== input.email.toLowerCase()) {
        throw new OrgError("This invite was sent to a different email address.", "invite_wrong_account");
      }
      if (invite.expired) {
        throw new OrgError("This invite has expired. Ask for a new one.", "invite_expired");
      }

      // Joining needs a paid Team plan with a free seat. The invite already
      // reserved one, so compare members only (not members + invites).
      const seatCheck: QueryResult<{ seats: number; members: string }> = await client.query(
        `SELECT o.seats, (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id)::text AS members
         FROM organizations o WHERE o.id = $1 FOR UPDATE`,
        [invite.org_id]
      );
      const seat = seatCheck.rows[0];
      if (seat && seat.seats === 0) {
        throw new OrgError(
          "This organization isn't on the Team plan yet, so it can't take members. Ask the owner to finish setting it up.",
          "not_set_up"
        );
      }
      if (seat && Number(seat.members) >= seat.seats) {
        throw new OrgError("All seats in this organization are taken. Ask an admin to add seats.", "no_seats");
      }

      await client.query(
        `INSERT INTO organization_members (org_id, account_id, role, invited_at, joined_at)
         VALUES ($1, $2, $3, now(), now())`,
        [invite.org_id, input.accountId, invite.role]
      );
      await client.query(`UPDATE org_invites SET accepted_at = now() WHERE id = $1`, [input.inviteId]);
      return { orgId: invite.org_id };
    });
  } catch (error: unknown) {
    if (error instanceof OrgError) throw error;
    if (isUniqueViolation(error)) {
      throw new OrgError("You're already in an organization. Leave it first.", "already_member");
    }
    logCaught("orgs.service.acceptInvite", error);
    throw error;
  }
}

/** The invitee turns an invite down (recorded as revoked). */
export async function declineInvite(inviteId: string, email: string): Promise<boolean> {
  try {
    const result = await getPool().query(
      `UPDATE org_invites SET revoked_at = now()
       WHERE id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [inviteId, email]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error: unknown) {
    logCaught("orgs.service.declineInvite", error);
    throw error;
  }
}

export async function updateMemberRole(orgId: string, accountId: string, role: OrgRole): Promise<void> {
  try {
    await getPool().query(
      `UPDATE organization_members SET role = $3 WHERE org_id = $1 AND account_id = $2`,
      [orgId, accountId, role]
    );
  } catch (error: unknown) {
    logCaught("orgs.service.updateMemberRole", error);
    throw error;
  }
}

/**
 * Deletes an org that never finished Team setup (the owner's "Cancel setup").
 * Refuses once it has a plan, credits, or any billing history — those records
 * must outlive the org. Unpaid checkout leftovers (pending subscriptions,
 * unpaid credit orders) are removed with it; the caller cancels the returned
 * Razorpay subscription ids after commit.
 */
export async function deleteUnpaidOrg(orgId: string): Promise<{ pendingRazorpaySubscriptionIds: string[] }> {
  try {
    return await withPoolTransaction(async (client: PoolClient) => {
      const locked: QueryResult<{ has_plan: boolean }> = await client.query(
        `SELECT plan_id IS NOT NULL AS has_plan FROM organizations WHERE id = $1 FOR UPDATE`,
        [orgId]
      );
      const org = locked.rows[0];
      if (!org) throw new OrgError("Organization not found.", "org_not_found");
      if (org.has_plan) {
        throw new OrgError("This organization has an active Team plan, so it can't be deleted.", "has_plan");
      }

      const history: QueryResult<{ has_history: boolean }> = await client.query(
        `SELECT
           COALESCE((SELECT balance FROM org_credit_wallets WHERE org_id = $1), 0) > 0
           OR EXISTS (SELECT 1 FROM credit_ledger WHERE org_id = $1)
           OR EXISTS (SELECT 1 FROM invoices WHERE org_id = $1)
           OR EXISTS (SELECT 1 FROM credit_purchases WHERE org_id = $1 AND status = 'succeeded')
           OR EXISTS (SELECT 1 FROM subscriptions WHERE org_id = $1 AND status <> 'pending')
           AS has_history`,
        [orgId]
      );
      if (history.rows[0]?.has_history) {
        throw new OrgError(
          "This organization has credits or billing history, so it can't be deleted. Contact support to close it.",
          "has_history"
        );
      }

      const pending: QueryResult<{ razorpay_subscription_id: string }> = await client.query(
        `DELETE FROM subscriptions WHERE org_id = $1 AND status = 'pending'
         RETURNING razorpay_subscription_id`,
        [orgId]
      );
      await client.query(`DELETE FROM credit_purchases WHERE org_id = $1 AND status <> 'succeeded'`, [orgId]);
      await client.query(`UPDATE projects SET org_id = NULL WHERE org_id = $1`, [orgId]);
      await client.query(`UPDATE payment_methods SET org_id = NULL WHERE org_id = $1`, [orgId]);
      // Members, invites, the (empty) pool, billing profile and API keys cascade.
      await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);

      return {
        pendingRazorpaySubscriptionIds: pending.rows
          .map((r) => r.razorpay_subscription_id)
          .filter((id): id is string => Boolean(id)),
      };
    });
  } catch (error: unknown) {
    if (error instanceof OrgError) throw error;
    logCaught("orgs.service.deleteUnpaidOrg", error);
    throw error;
  }
}

export async function removeMember(orgId: string, accountId: string): Promise<void> {
  try {
    await getPool().query(`DELETE FROM organization_members WHERE org_id = $1 AND account_id = $2`, [
      orgId,
      accountId,
    ]);
  } catch (error: unknown) {
    logCaught("orgs.service.removeMember", error);
    throw error;
  }
}
