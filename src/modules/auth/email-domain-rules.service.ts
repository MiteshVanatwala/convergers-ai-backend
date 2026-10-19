import type { QueryResult } from "pg";
import { getPool } from "../../infrastructure/db/pool";
import { withAdminTransaction } from "../../infrastructure/db/with-admin-transaction";
import { logCaught } from "../../shared/utils/log";
import { appendAdminAudit } from "../admin/admin-audit.service";

export type EmailDomainRuleAction = "block" | "allow";

export type EmailDomainRuleRow = {
  domain: string;
  action: EmailDomainRuleAction;
  note: string | null;
  created_by_label: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Admin overrides on top of the bundled disposable list (Admin → Email domains). */
export async function listEmailDomainRules(): Promise<EmailDomainRuleRow[]> {
  try {
    const result: QueryResult<EmailDomainRuleRow> = await getPool().query(
      `SELECT r.domain::text AS domain, r.action, r.note,
              COALESCE(a.display_name, a.username, a.email) AS created_by_label,
              r.created_at, r.updated_at
       FROM email_domain_rules r
       LEFT JOIN admin_users a ON a.id = r.created_by
       ORDER BY r.domain`
    );
    return result.rows;
  } catch (error: unknown) {
    logCaught("auth.email-domain-rules.service.listEmailDomainRules", error);
    throw error;
  }
}

/** Adds or changes a rule; returns the previous action (null = new rule). */
export async function saveEmailDomainRule(input: {
  domain: string;
  action: EmailDomainRuleAction;
  note: string | null;
  adminId: string;
}): Promise<EmailDomainRuleAction | null> {
  try {
    return await withAdminTransaction(input.adminId, async (client) => {
      const previous: QueryResult<{ action: EmailDomainRuleAction }> = await client.query(
        `SELECT action FROM email_domain_rules WHERE domain = $1 FOR UPDATE`,
        [input.domain]
      );
      await client.query(
        `INSERT INTO email_domain_rules (domain, action, note, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (domain) DO UPDATE
         SET action = EXCLUDED.action, note = EXCLUDED.note, updated_at = now()`,
        [input.domain, input.action, input.note, input.adminId]
      );
      const previousAction: EmailDomainRuleAction | null = previous.rows[0]?.action ?? null;
      await appendAdminAudit(
        {
          adminUserId: input.adminId,
          action: "email_domain_rule.saved",
          targetType: "email_domain",
          targetId: input.domain,
          meta: { action: input.action, previousAction, note: input.note },
        },
        client
      );
      return previousAction;
    });
  } catch (error: unknown) {
    logCaught("auth.email-domain-rules.service.saveEmailDomainRule", error);
    throw error;
  }
}

/** Removes a rule; false when there was none. */
export async function deleteEmailDomainRule(input: { domain: string; adminId: string }): Promise<boolean> {
  try {
    return await withAdminTransaction(input.adminId, async (client) => {
      const deleted: QueryResult<{ action: EmailDomainRuleAction }> = await client.query(
        `DELETE FROM email_domain_rules WHERE domain = $1 RETURNING action`,
        [input.domain]
      );
      if (!deleted.rows[0]) return false;
      await appendAdminAudit(
        {
          adminUserId: input.adminId,
          action: "email_domain_rule.deleted",
          targetType: "email_domain",
          targetId: input.domain,
          meta: { action: deleted.rows[0].action },
        },
        client
      );
      return true;
    });
  } catch (error: unknown) {
    logCaught("auth.email-domain-rules.service.deleteEmailDomainRule", error);
    throw error;
  }
}
