import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { optionalSession, requireSession } from "../../infrastructure/http/middleware/require-session";
import { getStorage } from "../../infrastructure/storage/object-storage";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import { getMembership } from "../orgs/orgs.service";
import { referenceSafe } from "./artifact-parser";
import * as artifactsService from "./artifacts.service";
import { VISIBILITIES, type ArtifactRow, type Visibility } from "./artifacts.service";
import { getFile, listImagesForAccount } from "./files.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 60;

function page(query: { limit?: string; offset?: string }): { limit: number; offset: number } {
  return {
    limit: Math.min(MAX_PAGE, Math.max(1, Number(query.limit) || 24)),
    offset: Math.max(0, Number(query.offset) || 0),
  };
}

function mapArtifact(row: ArtifactRow, viewerId: string | null) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    language: row.language,
    currentVersion: row.current_version,
    visibility: row.visibility,
    ownerName: row.owner_name?.trim() || null,
    isOwner: viewerId === row.account_id,
    conversationId: viewerId === row.account_id ? row.conversation_id : null,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Headers for user-generated content served from the API origin. It is
 * never rendered here: text/plain + nosniff + a sandbox CSP mean a browser
 * that opens the URL directly can't run it with the API's cookies. The web
 * app renders it inside a sandboxed iframe instead.
 */
function inertContentHeaders(reply: FastifyReply, shareable: boolean): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
  reply.header("Cache-Control", shareable ? "public, max-age=60" : "private, no-store");
}

/** GET /v1/artifacts — the signed-in user's artifacts, newest first. */
export async function listMine(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const { limit, offset } = page(request.query);
    const rows = await artifactsService.listForAccount(account.id, limit, offset);
    return ok(reply, AppStatus.ARTIFACTS_RETRIEVED, { items: rows.map((r) => mapArtifact(r, account.id)) });
  } catch (error: unknown) {
    logCaught("artifacts.controller.listMine", error);
    return fail(reply, AppStatus.ARTIFACT_FAILED, "Failed to load artifacts", 500);
  }
}

/** GET /v1/images — images the signed-in user generated in chat, for the library. */
export async function listMyImages(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const { limit, offset } = page(request.query);
    const rows = await listImagesForAccount(account.id, limit, offset);
    return ok(reply, AppStatus.IMAGES_RETRIEVED, {
      items: rows.map((r) => ({
        id: r.id,
        url: `/v1/files/${r.id}`,
        contentType: r.content_type,
        conversationId: r.conversation_id,
        conversationTitle: r.conversation_title,
        createdAt: r.created_at.toISOString(),
      })),
    });
  } catch (error: unknown) {
    logCaught("artifacts.controller.listMyImages", error);
    return fail(reply, AppStatus.FILE_FAILED, "Failed to load images", 500);
  }
}

/** GET /v1/artifacts/public — the public gallery (no sign-in). */
export async function listPublic(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  try {
    const { limit, offset } = page(request.query);
    const rows = await artifactsService.listPublic(limit, offset);
    reply.header("Cache-Control", "public, max-age=60");
    return ok(reply, AppStatus.ARTIFACTS_RETRIEVED, { items: rows.map((r) => mapArtifact(r, null)) });
  } catch (error: unknown) {
    logCaught("artifacts.controller.listPublic", error);
    return fail(reply, AppStatus.ARTIFACT_FAILED, "Failed to load the gallery", 500);
  }
}

/** Loads an artifact the viewer may see; anything else is a plain 404 (no hint it exists). */
async function loadViewable(id: string, viewerId: string | null): Promise<ArtifactRow | null> {
  if (!UUID_RE.test(id)) return null;
  const artifact = await artifactsService.getArtifact(id);
  if (!artifact) return null;
  return (await artifactsService.canView(artifact, viewerId)) ? artifact : null;
}

/** GET /v1/artifacts/:id — details, for anyone allowed to view it. */
export async function getOne(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    const viewer = await optionalSession(request);
    const artifact = await loadViewable(request.params.id, viewer?.id ?? null);
    if (!artifact) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact not found", 404);
    reply.header("Cache-Control", "private, no-store");
    return ok(reply, AppStatus.ARTIFACT_RETRIEVED, mapArtifact(artifact, viewer?.id ?? null));
  } catch (error: unknown) {
    logCaught("artifacts.controller.getOne", error);
    return fail(reply, AppStatus.ARTIFACT_FAILED, "Failed to load artifact", 500);
  }
}

/** GET /v1/artifacts/:id/content?version=N — the source, as inert text. */
export async function getContent(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { version?: string } }>,
  reply: FastifyReply
) {
  try {
    const viewer = await optionalSession(request);
    const artifact = await loadViewable(request.params.id, viewer?.id ?? null);
    if (!artifact) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact not found", 404);

    const requested = Number(request.query.version);
    // Only the owner can open older versions; everyone else sees the current one.
    const version =
      Number.isInteger(requested) && requested >= 1 && requested <= artifact.current_version &&
      viewer?.id === artifact.account_id
        ? requested
        : artifact.current_version;
    const file = await artifactsService.getVersionFileKey(artifact.id, version);
    const object = file ? await getStorage().get(file.storage_key) : null;
    if (!object) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact content not found", 404);

    inertContentHeaders(reply, artifact.visibility === "public" || artifact.visibility === "link");
    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.header("X-Artifact-Version", String(version));
    return reply.send(object.body);
  } catch (error: unknown) {
    logCaught("artifacts.controller.getContent", error);
    return fail(reply, AppStatus.ARTIFACT_FAILED, "Failed to load artifact", 500);
  }
}

/** PATCH /v1/artifacts/:id { title?, visibility? } — owner only. */
export async function update(
  request: FastifyRequest<{ Params: { id: string }; Body: { title?: unknown; visibility?: unknown } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    if (!UUID_RE.test(request.params.id)) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact not found", 404);
    const body = request.body ?? {};
    const input: { title?: string; visibility?: Visibility } = {};

    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? referenceSafe(body.title) : "";
      if (!title) return fail(reply, AppStatus.ARTIFACT_VALIDATION_FAILED, "Title can't be empty", 400);
      input.title = title;
    }
    if (body.visibility !== undefined) {
      if (typeof body.visibility !== "string" || !(VISIBILITIES as readonly string[]).includes(body.visibility)) {
        return fail(reply, AppStatus.ARTIFACT_VALIDATION_FAILED, "Unknown sharing option", 400);
      }
      if (body.visibility === "organization" && !(await getMembership(account.id))) {
        return fail(
          reply,
          AppStatus.ARTIFACT_VALIDATION_FAILED,
          "You're not in an organization, so there's no one to share it with there.",
          400
        );
      }
      input.visibility = body.visibility as Visibility;
    }

    const updated = await artifactsService.updateArtifact(request.params.id, account.id, input);
    if (!updated) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact not found", 404);
    const artifact = await artifactsService.getArtifact(request.params.id);
    return ok(reply, AppStatus.ARTIFACT_UPDATED, artifact ? mapArtifact(artifact, account.id) : null);
  } catch (error: unknown) {
    logCaught("artifacts.controller.update", error);
    return fail(reply, AppStatus.ARTIFACT_FAILED, "Failed to update artifact", 500);
  }
}

/** DELETE /v1/artifacts/:id — owner only; shared links stop working. */
export async function remove(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    if (!UUID_RE.test(request.params.id)) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact not found", 404);
    const deleted = await artifactsService.deleteArtifact(request.params.id, account.id);
    if (!deleted) return fail(reply, AppStatus.ARTIFACT_NOT_FOUND, "Artifact not found", 404);
    return ok(reply, AppStatus.ARTIFACT_DELETED, { ok: true });
  } catch (error: unknown) {
    logCaught("artifacts.controller.remove", error);
    return fail(reply, AppStatus.ARTIFACT_FAILED, "Failed to delete artifact", 500);
  }
}

/** GET /v1/files/:id — a generated file (e.g. an image) for its owner. */
export async function getFileContent(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { download?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    if (!UUID_RE.test(request.params.id)) return fail(reply, AppStatus.FILE_NOT_FOUND, "File not found", 404);
    const file = await getFile(request.params.id);
    if (!file || file.account_id !== account.id || file.kind === "artifact") {
      return fail(reply, AppStatus.FILE_NOT_FOUND, "File not found", 404);
    }
    const object = await getStorage().get(file.storage_key);
    if (!object) return fail(reply, AppStatus.FILE_NOT_FOUND, "File not found", 404);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
    // Files never change once written.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("Content-Type", file.content_type);
    // ?download=1 saves instead of displaying (the <a download> attribute is
    // ignored cross-origin, and the API is on a different origin from the app).
    if (request.query.download === "1") {
      const extension = file.storage_key.split(".").pop() ?? "bin";
      reply.header("Content-Disposition", `attachment; filename="aikya-${file.kind}-${file.id.slice(0, 8)}.${extension}"`);
    }
    if (object.size !== null) reply.header("Content-Length", String(object.size));
    return reply.send(object.body);
  } catch (error: unknown) {
    logCaught("artifacts.controller.getFileContent", error);
    return fail(reply, AppStatus.FILE_FAILED, "Failed to load file", 500);
  }
}
