import type { RouteRequest } from "@convergers-ai/shared-types";
import { getFile } from "../../artifacts/files.service";
import { getStorage } from "../../../infrastructure/storage/object-storage";

/** Shared by the image adapters: what the request asks for, and the image it may be editing. */

const FILE_REF = /!\[[^\]]*\]\(\/v1\/files\/([0-9a-f-]{36})\)/g;
const MAX_REFERENCE_IMAGE_BYTES = 7_000_000;

const ANIMATION = /\b(gif|gifs|animated|animation|animate|animating)\b/i;

/** "a GIF of…", "animate the logo", "an animated banner" — needs a model that can draw frames. */
export function wantsAnimation(prompt: string): boolean {
  return ANIMATION.test(prompt);
}

/** The latest image this account generated earlier in the conversation, if any. */
export async function previousImage(
  request: RouteRequest,
  accountId: string | null
): Promise<{ mimeType: string; data: string } | null> {
  if (!accountId || !request.history?.length) return null;
  for (let i = request.history.length - 1; i >= 0; i--) {
    const turn = request.history[i]!;
    if (turn.role !== "assistant") continue;
    const ids = [...turn.content.matchAll(FILE_REF)].map((m) => m[1]!);
    const id = ids[ids.length - 1];
    if (!id) continue;
    const file = await getFile(id);
    if (!file || file.account_id !== accountId || file.kind !== "image") return null;
    if (file.byte_size > MAX_REFERENCE_IMAGE_BYTES) return null;
    const object = await getStorage().get(file.storage_key);
    if (!object) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { mimeType: file.content_type, data: Buffer.concat(chunks).toString("base64") };
  }
  return null;
}
