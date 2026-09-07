import Fastify from "fastify";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { handleRequest } from "../brain";
import { registerAdminApi } from "../admin-api";

export function buildServer() {
  const app = Fastify({ logger: true });

  // TODO: auth, rate limiting — this is the gateway's job per §01, not the Brain's.

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: RouteRequest }>("/v1/route", async (request, reply) => {
    try {
      const result = await handleRequest(request.body);
      return result;
    } catch (err) {
      request.log.error(err);
      return reply.status(502).send({ error: "upstream_failure" });
    }
  });

  registerAdminApi(app);

  return app;
}
