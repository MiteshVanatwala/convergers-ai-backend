import { randomUUID } from "node:crypto";
import { logCaught } from "../../shared/utils/log";
import { saveFile } from "./files.service";

const DATA_IMAGE = /!\[([^\]\n]*)\]\(data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)\)/g;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Moves every data-URI image in a finished chat answer (what the image
 * adapters return) into object storage, replacing it with a /v1/files link.
 * An image that fails to save is dropped with a note rather than stuffing
 * megabytes of base64 into the messages table.
 */
export async function storeAnswerImages(input: {
  accountId: string;
  conversationId: string;
  content: string;
}): Promise<{ content: string; fileIds: string[] }> {
  const matches = [...input.content.matchAll(DATA_IMAGE)];
  if (matches.length === 0) return { content: input.content, fileIds: [] };

  const fileIds: string[] = [];
  let out = "";
  let last = 0;
  for (const m of matches) {
    const [whole, alt, contentType, base64] = m as unknown as [string, string, string, string];
    out += input.content.slice(last, m.index);
    last = (m.index ?? 0) + whole.length;
    try {
      const file = await saveFile({
        accountId: input.accountId,
        kind: "image",
        key: `images/${input.accountId}/${randomUUID()}.${EXTENSIONS[contentType] ?? "png"}`,
        body: Buffer.from(base64, "base64"),
        contentType,
        conversationId: input.conversationId,
      });
      fileIds.push(file.id);
      out += `![${alt}](/v1/files/${file.id})`;
    } catch (error: unknown) {
      logCaught("artifacts.chat-images.storeAnswerImages", error);
      out += "_(The image was generated but couldn't be saved. Please try again.)_";
    }
  }
  out += input.content.slice(last);
  return { content: out, fileIds };
}
