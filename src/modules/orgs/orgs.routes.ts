import type { FastifyInstance } from "fastify";
import * as orgsController from "./orgs.controller";

export function registerOrgRoutes(app: FastifyInstance): void {
  app.get("/v1/org", (request, reply) => orgsController.getMyOrg(request, reply));

  // No POST /v1/org: orgs are created by Team checkout (POST /v1/org/subscription with orgName).
  app.delete("/v1/org", (request, reply) => orgsController.deleteOrg(request, reply));

  app.patch<{ Body: { name?: string } }>("/v1/org", (request, reply) =>
    orgsController.renameOrg(request, reply)
  );

  app.patch<{ Body: { enforceSensitiveFilter?: boolean; allowedModelIds?: string[] | null } }>(
    "/v1/org/settings",
    (request, reply) => orgsController.updateSettings(request, reply)
  );

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/org/usage", (request, reply) =>
    orgsController.getUsage(request, reply)
  );

  app.post<{ Body: { seats?: number; orgName?: string } }>("/v1/org/subscription", (request, reply) =>
    orgsController.startSubscription(request, reply)
  );

  app.patch<{ Body: { seats?: number } }>("/v1/org/subscription", (request, reply) =>
    orgsController.changeSeats(request, reply)
  );

  app.post("/v1/org/leave", (request, reply) => orgsController.leaveOrg(request, reply));

  app.post<{ Body: { email?: string; role?: string } }>("/v1/org/invites", (request, reply) =>
    orgsController.createInvite(request, reply)
  );

  app.delete<{ Params: { id: string } }>("/v1/org/invites/:id", (request, reply) =>
    orgsController.revokeInvite(request, reply)
  );

  app.post<{ Params: { id: string } }>("/v1/org/invites/:id/accept", (request, reply) =>
    orgsController.acceptInvite(request, reply)
  );

  app.post<{ Params: { id: string } }>("/v1/org/invites/:id/decline", (request, reply) =>
    orgsController.declineInvite(request, reply)
  );

  app.patch<{ Params: { accountId: string }; Body: { role?: string; monthlyCreditLimit?: number | null } }>(
    "/v1/org/members/:accountId",
    (request, reply) => orgsController.updateMember(request, reply)
  );

  app.delete<{ Params: { accountId: string } }>("/v1/org/members/:accountId", (request, reply) =>
    orgsController.removeMember(request, reply)
  );
}
