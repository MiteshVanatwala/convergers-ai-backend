import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as featuresService from "../plans/plan-features.service";
import { FeatureCatalogError } from "../plans/plan-features.service";

function failFromFeatureCatalogError(reply: FastifyReply, error: FeatureCatalogError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.ADMIN_FEATURE_VALIDATION_FAILED, error.message, 400);
    case "not_found":
      return fail(reply, AppStatus.ADMIN_FEATURE_NOT_FOUND, error.message, 404);
  }
}

export async function listFeatures(request: FastifyRequest, reply: FastifyReply) {
  try {
    const features = await featuresService.listFeatureCatalog();
    return ok(reply, AppStatus.ADMIN_FEATURES_RETRIEVED, features);
  } catch (error: unknown) {
    logCaught("admin.admin-feature-catalog.controller.listFeatures", error);
    return fail(reply, AppStatus.ADMIN_FEATURES_FETCH_FAILED, "Failed to list features", 500);
  }
}

export async function createFeature(
  request: FastifyRequest<{ Body: { label?: string; description?: string | null } }>,
  reply: FastifyReply
) {
  try {
    const label = typeof request.body?.label === "string" ? request.body.label : "";
    const description = typeof request.body?.description === "string" ? request.body.description : null;
    const result = await featuresService.createFeature({
      actorId: request.admin!.id,
      label,
      description,
    });
    return ok(reply, AppStatus.ADMIN_FEATURE_CREATED, result);
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) return failFromFeatureCatalogError(reply, error);
    logCaught("admin.admin-feature-catalog.controller.createFeature", error);
    return fail(reply, AppStatus.ADMIN_FEATURE_CREATE_FAILED, "Failed to create feature", 500);
  }
}

export async function updateFeature(
  request: FastifyRequest<{ Params: { key: string }; Body: { label?: string; description?: string | null } }>,
  reply: FastifyReply
) {
  try {
    const result = await featuresService.updateFeature({
      actorId: request.admin!.id,
      key: request.params.key,
      label: typeof request.body?.label === "string" ? request.body.label : undefined,
      description: request.body?.description,
    });
    return ok(reply, AppStatus.ADMIN_FEATURE_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) return failFromFeatureCatalogError(reply, error);
    logCaught("admin.admin-feature-catalog.controller.updateFeature", error);
    return fail(reply, AppStatus.ADMIN_FEATURE_UPDATE_FAILED, "Failed to update feature", 500);
  }
}

export async function deleteFeature(
  request: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply
) {
  try {
    await featuresService.deleteFeature({ actorId: request.admin!.id, key: request.params.key });
    return ok(reply, AppStatus.ADMIN_FEATURE_DELETED, { key: request.params.key });
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) return failFromFeatureCatalogError(reply, error);
    logCaught("admin.admin-feature-catalog.controller.deleteFeature", error);
    return fail(reply, AppStatus.ADMIN_FEATURE_DELETE_FAILED, "Failed to delete feature", 500);
  }
}

export async function listPlanFeatureAccess(request: FastifyRequest, reply: FastifyReply) {
  try {
    const entries = await featuresService.listPlanFeatureAccess();
    return ok(reply, AppStatus.ADMIN_PLAN_FEATURE_ACCESS_RETRIEVED, entries);
  } catch (error: unknown) {
    logCaught("admin.admin-feature-catalog.controller.listPlanFeatureAccess", error);
    return fail(
      reply,
      AppStatus.ADMIN_PLAN_FEATURE_ACCESS_FETCH_FAILED,
      "Failed to list plan feature access",
      500
    );
  }
}

export async function updatePlanFeatureAccess(
  request: FastifyRequest<{ Params: { key: string }; Body: { planKeys?: string[] } }>,
  reply: FastifyReply
) {
  try {
    const planKeys = Array.isArray(request.body?.planKeys)
      ? request.body.planKeys.filter((k): k is string => typeof k === "string")
      : null;
    if (!planKeys) {
      return fail(
        reply,
        AppStatus.ADMIN_PLAN_FEATURE_ACCESS_VALIDATION_FAILED,
        "planKeys must be an array of plan keys",
        400
      );
    }
    const result = await featuresService.updatePlanFeatureAccess({
      actorId: request.admin!.id,
      featureKey: request.params.key,
      planKeys,
    });
    return ok(reply, AppStatus.ADMIN_PLAN_FEATURE_ACCESS_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof FeatureCatalogError) {
      switch (error.kind) {
        case "validation":
          return fail(reply, AppStatus.ADMIN_PLAN_FEATURE_ACCESS_VALIDATION_FAILED, error.message, 400);
        case "not_found":
          return fail(reply, AppStatus.ADMIN_FEATURE_NOT_FOUND, error.message, 404);
      }
    }
    logCaught("admin.admin-feature-catalog.controller.updatePlanFeatureAccess", error);
    return fail(
      reply,
      AppStatus.ADMIN_PLAN_FEATURE_ACCESS_UPDATE_FAILED,
      "Failed to update plan feature access",
      500
    );
  }
}
