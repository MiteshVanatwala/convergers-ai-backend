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

// Flat, text-heavy or geometric graphics — what drawing with code does well
// (claudeImage.ts). Photos and painterly scenes are left to the image models.
const DRAWN_GRAPHIC =
  /\b(?:logo|logotype|wordmark|monogram|icon|badge|sticker|emoji|typography|lettering|text that says|with the (?:text|words)|quote card|banner|poster|flyer|infographic|chart|graph|diagram|flow ?chart|pattern|geometric|pixel art|ascii|qr|meme)\b/i;

/** "a logo with the words…", "a geometric pattern", "an infographic" — drawn better with code than painted. */
export function wantsDrawnGraphic(prompt: string): boolean {
  return DRAWN_GRAPHIC.test(prompt);
}

const IMAGE_MARKDOWN = /!\[[^\]]*\]\((?:\/v1\/files\/[0-9a-f-]{36}|data:image\/[^)]*)\)/g;

/**
 * Earlier turns as plain text, so "a cover image for the story above" knows the
 * story. Image links are dropped (the latest image is passed as pixels — see
 * `previousImage`); turns left empty are skipped and the neighbours that leaves
 * side by side are merged, so roles alternate starting with the user.
 */
export function contextTurns(
  request: RouteRequest,
  { maxTurns = 6, maxCharsPerTurn = 12_000 }: { maxTurns?: number; maxCharsPerTurn?: number } = {}
): Array<{ role: "user" | "assistant"; text: string }> {
  const turns = (request.history ?? [])
    .slice(-maxTurns)
    .map((turn) => ({ role: turn.role, text: turn.content.replace(IMAGE_MARKDOWN, "").trim().slice(0, maxCharsPerTurn) }))
    .filter((turn) => turn.text);
  while (turns[0]?.role === "assistant") turns.shift();
  const merged: typeof turns = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last?.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else merged.push({ ...turn });
  }
  return merged;
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
