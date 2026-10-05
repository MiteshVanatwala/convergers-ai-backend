import type { SessionAccount } from "../modules/auth/types";
import type { ActiveAdminUser } from "../modules/admin/admin-auth.service";

declare module "fastify" {
  interface FastifyRequest {
    account?: SessionAccount;
    admin?: ActiveAdminUser;
    adminPermissions?: string[];
  }
}

