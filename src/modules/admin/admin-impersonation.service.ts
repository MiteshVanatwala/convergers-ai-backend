import type { PoolClient } from "pg";
import { loadEnv } from "../../config/env";
import { withAdminTransaction } from "../../infrastructure/db/with-admin-transaction";
import { logCaught } from "../../shared/utils/log";
import { newSessionToken } from "../../shared/utils/session-token";
import * as authService from "../auth/auth.service";
import { appendAdminAudit } from "./admin-audit.service";
import { getUserById } from "./users.service";

export type ImpersonationErrorKind = "validation" | "not_found";

export class ImpersonationError extends Error {
  constructor(
    message: string,
    readonly kind: ImpersonationErrorKind
  ) {
    super(message);
    this.name = "ImpersonationError";
  }
}

export async function impersonateUser(input: {
  actorId: string;
  accountId: string;
  reason: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; accountEmail: string }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ImpersonationError("A reason is required to start impersonation", "validation");
  }

  try {
    const account = await getUserById(input.accountId);
    if (!account) {
      throw new ImpersonationError("Account not found", "not_found");
    }
    if (account.status !== "active") {
      throw new ImpersonationError(`Cannot impersonate a ${account.status} account`, "validation");
    }

    const token = newSessionToken();
    const ttlMinutes = loadEnv().impersonationTtlMinutes;

    await withAdminTransaction(input.actorId, async (client: PoolClient) => {
      await authService.createSession({
        accountId: input.accountId,
        token,
        ip: input.ip,
        userAgent: input.userAgent,
        ttlMinutes,
        impersonatedBy: input.actorId,
        impersonationReason: reason,
        client,
      });

      await appendAdminAudit(
        {
          adminUserId: input.actorId,
          action: "account.impersonate",
          targetType: "account",
          targetId: input.accountId,
          reason,
        },
        client
      );
    });

    return { token, accountEmail: account.email };
  } catch (error: unknown) {
    if (error instanceof ImpersonationError) throw error;
    logCaught("admin.admin-impersonation.service.impersonateUser", error);
    throw error;
  }
}
