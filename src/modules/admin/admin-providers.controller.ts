import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as providersService from "./admin-providers.service";
import { ProviderConfigError } from "./admin-providers.service";

function failFromProviderConfigError(reply: FastifyReply, error: ProviderConfigError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.ADMIN_PROVIDER_VALIDATION_FAILED, error.message, 400);
    case "not_found":
      return fail(reply, AppStatus.ADMIN_PROVIDER_NOT_FOUND, error.message, 404);
    default:
      return fail(reply, AppStatus.ADMIN_PROVIDER_KEY_FAILED, error.message, 500);
  }
}

export async function listCredentials(request: FastifyRequest, reply: FastifyReply) {
  try {
    const credentials = await providersService.listCredentials();
    return ok(reply, AppStatus.ADMIN_PROVIDERS_RETRIEVED, credentials);
  } catch (error: unknown) {
    logCaught("admin.admin-providers.controller.listCredentials", error);
    return fail(reply, AppStatus.ADMIN_PROVIDERS_FETCH_FAILED, "Failed to list provider credentials", 500);
  }
}

export async function setCredentialKey(
  request: FastifyRequest<{ Params: { id: string }; Body: { apiKey?: string } }>,
  reply: FastifyReply
) {
  try {
    const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey : "";
    const result = await providersService.setCredentialKey({
      actorId: request.admin!.id,
      credentialId: request.params.id,
      apiKey,
    });
    return ok(reply, AppStatus.ADMIN_PROVIDER_KEY_SET, result);
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) {
      return failFromProviderConfigError(reply, error);
    }
    logCaught("admin.admin-providers.controller.setCredentialKey", error);
    return fail(reply, AppStatus.ADMIN_PROVIDER_KEY_FAILED, "Failed to set provider key", 500);
  }
}

export async function listRegistry(request: FastifyRequest, reply: FastifyReply) {
  try {
    const registry = await providersService.listRegistry();
    return ok(reply, AppStatus.ADMIN_PROVIDER_REGISTRY_RETRIEVED, registry);
  } catch (error: unknown) {
    logCaught("admin.admin-providers.controller.listRegistry", error);
    return fail(reply, AppStatus.ADMIN_PROVIDER_REGISTRY_FETCH_FAILED, "Failed to list provider models", 500);
  }
}

export async function setVisibility(
  request: FastifyRequest<{ Params: { id: string }; Body: { visible?: boolean } }>,
  reply: FastifyReply
) {
  try {
    if (typeof request.body?.visible !== "boolean") {
      return fail(
        reply,
        AppStatus.ADMIN_PROVIDER_VALIDATION_FAILED,
        "visible must be a boolean",
        400
      );
    }
    const result = await providersService.setVisibility({
      actorId: request.admin!.id,
      providerId: request.params.id,
      visible: request.body.visible,
    });
    return ok(reply, AppStatus.ADMIN_PROVIDER_VISIBILITY_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) {
      return failFromProviderConfigError(reply, error);
    }
    logCaught("admin.admin-providers.controller.setVisibility", error);
    return fail(
      reply,
      AppStatus.ADMIN_PROVIDER_VISIBILITY_UPDATE_FAILED,
      "Failed to update visibility",
      500
    );
  }
}

export async function setCapabilities(
  request: FastifyRequest<{ Params: { id: string }; Body: { capabilities?: string[] } }>,
  reply: FastifyReply
) {
  try {
    const capabilities = Array.isArray(request.body?.capabilities)
      ? request.body.capabilities.filter((c): c is string => typeof c === "string")
      : null;
    if (!capabilities) {
      return fail(
        reply,
        AppStatus.ADMIN_PROVIDER_CAPABILITIES_VALIDATION_FAILED,
        "capabilities must be an array of strings",
        400
      );
    }
    const result = await providersService.setCapabilities({
      actorId: request.admin!.id,
      providerId: request.params.id,
      capabilities,
    });
    return ok(reply, AppStatus.ADMIN_PROVIDER_CAPABILITIES_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) {
      switch (error.kind) {
        case "validation":
          return fail(reply, AppStatus.ADMIN_PROVIDER_CAPABILITIES_VALIDATION_FAILED, error.message, 400);
        case "not_found":
          return fail(reply, AppStatus.ADMIN_PROVIDER_NOT_FOUND, error.message, 404);
      }
    }
    logCaught("admin.admin-providers.controller.setCapabilities", error);
    return fail(
      reply,
      AppStatus.ADMIN_PROVIDER_CAPABILITIES_UPDATE_FAILED,
      "Failed to update capabilities",
      500
    );
  }
}

export async function listRoutingRules(request: FastifyRequest, reply: FastifyReply) {
  try {
    const rules = await providersService.listRoutingRules();
    return ok(reply, AppStatus.ADMIN_PROVIDER_ROUTING_RETRIEVED, rules);
  } catch (error: unknown) {
    logCaught("admin.admin-providers.controller.listRoutingRules", error);
    return fail(
      reply,
      AppStatus.ADMIN_PROVIDER_ROUTING_FETCH_FAILED,
      "Failed to list provider routing rules",
      500
    );
  }
}

export async function updateRoutingRules(
  request: FastifyRequest<{
    Params: { taskType: string };
    Body: { entries?: Array<{ providerId?: string; enabled?: boolean }> };
  }>,
  reply: FastifyReply
) {
  try {
    const rawEntries = Array.isArray(request.body?.entries) ? request.body.entries : [];
    const entries: Array<{ providerId: string; enabled: boolean }> = [];
    for (const entry of rawEntries) {
      if (typeof entry.providerId !== "string" || !entry.providerId.trim()) {
        return fail(
          reply,
          AppStatus.ADMIN_PROVIDER_ROUTING_VALIDATION_FAILED,
          "every entry needs a providerId",
          400
        );
      }
      entries.push({ providerId: entry.providerId, enabled: Boolean(entry.enabled) });
    }

    const result = await providersService.updateRoutingRules({
      actorId: request.admin!.id,
      taskType: request.params.taskType,
      entries,
    });
    return ok(reply, AppStatus.ADMIN_PROVIDER_ROUTING_UPDATED, { entries: result });
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) {
      switch (error.kind) {
        case "validation":
          return fail(reply, AppStatus.ADMIN_PROVIDER_ROUTING_VALIDATION_FAILED, error.message, 400);
        default:
          return fail(reply, AppStatus.ADMIN_PROVIDER_ROUTING_UPDATE_FAILED, error.message, 500);
      }
    }
    logCaught("admin.admin-providers.controller.updateRoutingRules", error);
    return fail(
      reply,
      AppStatus.ADMIN_PROVIDER_ROUTING_UPDATE_FAILED,
      "Failed to update provider routing rules",
      500
    );
  }
}

export async function listTierAccess(request: FastifyRequest, reply: FastifyReply) {
  try {
    const entries = await providersService.listTierAccess();
    return ok(reply, AppStatus.ADMIN_PROVIDER_TIER_ACCESS_RETRIEVED, entries);
  } catch (error: unknown) {
    logCaught("admin.admin-providers.controller.listTierAccess", error);
    return fail(
      reply,
      AppStatus.ADMIN_PROVIDER_TIER_ACCESS_FETCH_FAILED,
      "Failed to list plan access",
      500
    );
  }
}

export async function updateTierAccess(
  request: FastifyRequest<{ Params: { id: string }; Body: { planKeys?: string[] } }>,
  reply: FastifyReply
) {
  try {
    const planKeys = Array.isArray(request.body?.planKeys)
      ? request.body.planKeys.filter((k): k is string => typeof k === "string")
      : null;
    if (!planKeys) {
      return fail(
        reply,
        AppStatus.ADMIN_PROVIDER_TIER_ACCESS_VALIDATION_FAILED,
        "planKeys must be an array of plan keys",
        400
      );
    }
    const result = await providersService.updateTierAccess({
      actorId: request.admin!.id,
      providerId: request.params.id,
      planKeys,
    });
    return ok(reply, AppStatus.ADMIN_PROVIDER_TIER_ACCESS_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof ProviderConfigError) {
      switch (error.kind) {
        case "validation":
          return fail(reply, AppStatus.ADMIN_PROVIDER_TIER_ACCESS_VALIDATION_FAILED, error.message, 400);
        case "not_found":
          return fail(reply, AppStatus.ADMIN_PROVIDER_NOT_FOUND, error.message, 404);
        default:
          return fail(reply, AppStatus.ADMIN_PROVIDER_TIER_ACCESS_UPDATE_FAILED, error.message, 500);
      }
    }
    logCaught("admin.admin-providers.controller.updateTierAccess", error);
    return fail(
      reply,
      AppStatus.ADMIN_PROVIDER_TIER_ACCESS_UPDATE_FAILED,
      "Failed to update plan access",
      500
    );
  }
}
