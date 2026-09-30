import type { FastifyReply, FastifyRequest } from "fastify";
import type { QueryResult } from "pg";
import type { RouteRequest } from "@convergers-ai/shared-types";
import { AppStatus } from "../../config/app-status-codes";
import { loadEnv } from "../../config/env";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import {
  INSUFFICIENT_CREDITS_CODE,
  handleRequest,
  handleStreamRequest,
  userFacingPayload,
} from "../brain";
import { getSpendable } from "../ledger/spend.service";
import { getOrgPolicyForAccount } from "../orgs/orgs.service";
import { getPool } from "../../infrastructure/db/pool";
import { isConfigured } from "../brain/adapters/keyStore";
import { getOrEnsureActivePlan, listCatalogPlans, PLAN_KEY_ORDER } from "../plans/plans.service";
import * as myKeysService from "./my-keys.service";
import { MyKeyError } from "./my-keys.service";

type VisibleModelRow = { id: string; label: string; key_provider_id: string | null };

export async function models(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const pool = getPool();
    const result: QueryResult<VisibleModelRow> = await pool.query(
      `SELECT id, label, key_provider_id
       FROM provider_registry
       WHERE visible_to_users = true AND status = 'active'
       ORDER BY label`
    );
    const rows = result.rows.filter(
      (row) => row.key_provider_id != null && isConfigured(row.key_provider_id)
    );

    const [ownKeysResult, plan, tierResult, catalogPlans, orgPolicy] = await Promise.all([
      pool.query<{ provider_id: string }>(
        `SELECT DISTINCT provider_id FROM provider_api_keys WHERE account_id = $1 AND is_active = true`,
        [account.id]
      ),
      getOrEnsureActivePlan(account.id),
      rows.length > 0
        ? pool.query<{ provider_id: string; plan_key: string }>(
            `SELECT provider_id, plan_key FROM provider_tier_access WHERE provider_id = ANY($1::text[])`,
            [rows.map((r) => r.id)]
          )
        : Promise.resolve({ rows: [] as { provider_id: string; plan_key: string }[] }),
      listCatalogPlans(),
      getOrgPolicyForAccount(account.id),
    ]);
    const orgAllowed = orgPolicy?.allowedModelIds ? new Set(orgPolicy.allowedModelIds) : null;

    const ownKeyProviderIds = new Set(ownKeysResult.rows.map((r) => r.provider_id));
    const allowedPlanKeysByModel = new Map<string, Set<string>>();
    for (const row of tierResult.rows) {
      const set = allowedPlanKeysByModel.get(row.provider_id) ?? new Set<string>();
      set.add(row.plan_key);
      allowedPlanKeysByModel.set(row.provider_id, set);
    }
    const planDisplayNameByKey = new Map(catalogPlans.map((p) => [p.key, p.display_name]));

    const items = rows.map((row) => {
      // Org policy wins over plan tier and own keys — admins decide which models members use.
      if (orgAllowed && !orgAllowed.has(row.id)) {
        return {
          id: row.id,
          label: row.label,
          locked: true,
          unlockHint: `Not allowed in ${orgPolicy?.orgName}`,
        };
      }
      const hasOwnKey = row.key_provider_id != null && ownKeyProviderIds.has(row.key_provider_id);
      const allowedPlanKeys = allowedPlanKeysByModel.get(row.id) ?? new Set<string>();
      const tierOk = allowedPlanKeys.has(plan.key);
      if (hasOwnKey || tierOk) {
        return { id: row.id, label: row.label, locked: false };
      }
      const orderedAllowed = PLAN_KEY_ORDER.filter((k) => allowedPlanKeys.has(k));
      const unlockPlanKey = orderedAllowed[0] ?? [...allowedPlanKeys][0];
      const unlockPlanLabel = unlockPlanKey ? planDisplayNameByKey.get(unlockPlanKey) : null;
      const unlockHint = unlockPlanLabel
        ? `Requires ${unlockPlanLabel}, or add your own key in Settings`
        : `Add your own key in Settings to use this model`;
      return { id: row.id, label: row.label, locked: true, unlockHint };
    });

    return ok(reply, AppStatus.MODELS_RETRIEVED, { items });
  } catch (error: unknown) {
    logCaught("routing.controller.models", error);
    request.log.error({ err: error }, "[routing.controller.models] failed");
    return fail(reply, AppStatus.MODELS_FETCH_FAILED, "Failed to list models", 500);
  }
}

function failFromMyKeyError(reply: FastifyReply, error: MyKeyError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.MY_KEY_VALIDATION_FAILED, error.message, 400);
    case "not_found":
      return fail(reply, AppStatus.MY_KEY_NOT_FOUND, error.message, 404);
  }
}

export async function myKeys(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const keys = await myKeysService.listMyKeys(account.id);
    return ok(reply, AppStatus.MY_KEYS_RETRIEVED, keys);
  } catch (error: unknown) {
    logCaught("routing.controller.myKeys", error);
    return fail(reply, AppStatus.MY_KEYS_FETCH_FAILED, "Failed to list your keys", 500);
  }
}

export async function setMyKey(
  request: FastifyRequest<{ Params: { id: string }; Body: { apiKey?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey : "";
    const result = await myKeysService.setMyKey({
      accountId: account.id,
      credentialId: request.params.id,
      apiKey,
    });
    return ok(reply, AppStatus.MY_KEY_SET, result);
  } catch (error: unknown) {
    if (error instanceof MyKeyError) return failFromMyKeyError(reply, error);
    logCaught("routing.controller.setMyKey", error);
    return fail(reply, AppStatus.MY_KEY_SET_FAILED, "Failed to save your key", 500);
  }
}

export async function deleteMyKey(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const result = await myKeysService.deleteMyKey({
      accountId: account.id,
      credentialId: request.params.id,
    });
    return ok(reply, AppStatus.MY_KEY_DELETED, result);
  } catch (error: unknown) {
    if (error instanceof MyKeyError) return failFromMyKeyError(reply, error);
    logCaught("routing.controller.deleteMyKey", error);
    return fail(reply, AppStatus.MY_KEY_DELETE_FAILED, "Failed to remove your key", 500);
  }
}

export async function credits(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const spendable = await getSpendable(account.id);
    return ok(reply, AppStatus.CREDITS_RETRIEVED, {
      accountId: account.id,
      /** What this account can spend now — for org members, the pool within their monthly limit. */
      balance: spendable.balance,
      source: spendable.context.kind,
      ...(spendable.context.kind === "org"
        ? {
            orgName: spendable.context.orgName,
            poolBalance: spendable.poolBalance,
            monthlyLimit: spendable.context.monthlyLimit,
            spentThisMonth: spendable.spentThisMonth,
          }
        : {}),
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
    const payload = userFacingPayload(err);
    if (payload.code === INSUFFICIENT_CREDITS_CODE) {
      return reply.status(402).send({ error: INSUFFICIENT_CREDITS_CODE, message: payload.message });
    }
    return reply.status(502).send({
      error: "upstream_failure",
      message: payload.message,
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
    send("error", userFacingPayload(err));
  } finally {
    res.end();
  }
}
