import Fastify from "fastify";
import cors from "@fastify/cors";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { handleRequest, handleStreamRequest } from "../brain";
import { registerAdminApi } from "../admin-api";
import { getBalance } from "../ledger";

// POC: no auth yet, so every request bills one shared demo account.
const DEMO_ACCOUNT_ID = "demo";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: [
      ...(process.env.WEB_ORIGIN ?? "http://localhost:3000").split(","),
      ...(process.env.ADMIN_ORIGIN ?? "http://localhost:3002").split(","),
    ],
  });

  // TODO: auth, rate limiting — this is the gateway's job per §01, not the Brain's.

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/credits", async () => ({
    accountId: DEMO_ACCOUNT_ID,
    balance: getBalance(DEMO_ACCOUNT_ID),
  }));

  app.post<{ Body: RouteRequest }>("/v1/route", async (request, reply) => {
    try {
      const result = await handleRequest(request.body, DEMO_ACCOUNT_ID);
      return result;
    } catch (err) {
      request.log.error(err);
      return reply.status(502).send({
        error: "upstream_failure",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Streaming counterpart to /v1/route — Server-Sent Events, one "delta"
  // event per chunk of text, then a single "done" event carrying the same
  // RouteResponse shape /v1/route returns (or "error" on failure).
  app.post<{ Body: RouteRequest }>("/v1/route/stream", async (request, reply) => {
    // @fastify/cors sets its headers (e.g. access-control-allow-origin) on
    // `reply` via its onRequest hook, but writing to `reply.raw` directly
    // bypasses Fastify's normal send path — carry them over by hand, or
    // the browser's CORS check on this endpoint silently fails.
    const corsHeaders = reply.getHeaders();
    reply.hijack();
    const res = reply.raw;
    for (const [key, value] of Object.entries(corsHeaders)) {
      if (value !== undefined) res.setHeader(key, value);
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.writeHead(200);

    const send = (event: string, data: unknown) => {
      if (res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await handleStreamRequest(
        request.body,
        DEMO_ACCOUNT_ID,
        (text) => send("delta", { text }),
        (event) => send("stage", event)
      );
      send("done", result);
    } catch (err) {
      request.log.error(err);
      send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  registerAdminApi(app);

  return app;
}
