import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { AppStatus } from "../../config/app-status-codes";
import { loadEnv } from "../../config/env";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import { handleRequest, handleStreamRequest } from "../brain";
import { getBalance } from "../ledger/ledger.service";

export async function credits(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const balance = await getBalance(account.id);
    return ok(reply, AppStatus.CREDITS_RETRIEVED, {
      accountId: account.id,
      balance,
    });
  } catch (error: unknown) {
    logCaught("routing.controller.credits", error);
    request.log.error({ err: error }, "[routing.controller.credits] failed");
    return fail(reply, AppStatus.CREDITS_FETCH_FAILED, "Failed to load credits", 500);
  }
}

export async function route(
  request: FastifyRequest<{ Body: RouteRequest }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    return await handleRequest(request.body, account.id);
  } catch (err) {
    request.log.error(
      { err },
      `[routing.controller.route] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    return reply.status(502).send({
      error: "upstream_failure",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function routeStream(
  request: FastifyRequest<{ Body: RouteRequest }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;

  const corsHeaders = reply.getHeaders();
  reply.hijack();
  const res = reply.raw;
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (value !== undefined) res.setHeader(key, value);
  }

  const env = loadEnv();
  const origin = request.headers.origin;
  const allowed = [...env.webOrigins, ...env.adminOrigins];
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
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
      account.id,
      (text) => send("delta", { text }),
      (event) => send("stage", event)
    );
    send("done", result);
  } catch (err) {
    request.log.error(
      { err },
      `[routing.controller.routeStream] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    send("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}
