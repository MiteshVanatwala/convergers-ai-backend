import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as projectsService from "./projects.service";

type IdParams = { id: string };

export async function listProjects(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const rows = await projectsService.listProjects(account.id);
    return ok(reply, AppStatus.PROJECTS_LIST_RETRIEVED, {
      items: rows.map(projectsService.mapProject),
    });
  } catch (error: unknown) {
    logCaught("projects.controller.listProjects", error);
    request.log.error({ err: error }, "[projects.controller.listProjects] failed");
    return fail(reply, AppStatus.PROJECTS_FETCH_FAILED, "Failed to load projects", 500);
  }
}

export async function createProject(
  request: FastifyRequest<{ Body: { name?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const raw = request.body?.name;
    if (typeof raw !== "string") {
      return fail(reply, AppStatus.PROJECT_VALIDATION_FAILED, "name is required", 400);
    }
    const name = projectsService.normalizeProjectName(raw);
    if (!name) {
      return fail(
        reply,
        AppStatus.PROJECT_VALIDATION_FAILED,
        "Name must be 1–80 characters",
        400
      );
    }
    const row = await projectsService.createProject(account.id, name);
    return ok(reply, AppStatus.PROJECT_CREATED, projectsService.mapProject(row));
  } catch (error: unknown) {
    logCaught("projects.controller.createProject", error);
    request.log.error({ err: error }, "[projects.controller.createProject] failed");
    return fail(reply, AppStatus.PROJECT_CREATE_FAILED, "Failed to create project", 500);
  }
}

export async function patchProject(
  request: FastifyRequest<{ Params: IdParams; Body: { name?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const body = request.body ?? {};
    if (body.name === undefined) {
      return fail(reply, AppStatus.PROJECT_VALIDATION_FAILED, "No fields to update", 400);
    }
    if (typeof body.name !== "string") {
      return fail(reply, AppStatus.PROJECT_VALIDATION_FAILED, "Invalid name", 400);
    }
    const name = projectsService.normalizeProjectName(body.name);
    if (!name) {
      return fail(
        reply,
        AppStatus.PROJECT_VALIDATION_FAILED,
        "Name must be 1–80 characters",
        400
      );
    }
    const row = await projectsService.updateProject(account.id, request.params.id, { name });
    if (!row) {
      return fail(reply, AppStatus.PROJECT_NOT_FOUND, "Project not found", 404);
    }
    return ok(reply, AppStatus.PROJECT_UPDATED, projectsService.mapProject(row));
  } catch (error: unknown) {
    logCaught("projects.controller.patchProject", error);
    request.log.error({ err: error }, "[projects.controller.patchProject] failed");
    return fail(reply, AppStatus.PROJECT_UPDATE_FAILED, "Failed to update project", 500);
  }
}

export async function archiveProject(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const okArchive = await projectsService.archiveProject(account.id, request.params.id);
    if (!okArchive) {
      return fail(reply, AppStatus.PROJECT_NOT_FOUND, "Project not found", 404);
    }
    return ok(reply, AppStatus.PROJECT_ARCHIVED, { id: request.params.id });
  } catch (error: unknown) {
    logCaught("projects.controller.archiveProject", error);
    request.log.error({ err: error }, "[projects.controller.archiveProject] failed");
    return fail(reply, AppStatus.PROJECT_ARCHIVE_FAILED, "Failed to delete project", 500);
  }
}
