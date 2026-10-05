import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { RouteRequest } from "@convergers-ai/shared-types";
import type { ProviderAdapter, ProviderResponse } from "./types";
import { nativeCost, type TokenUsage } from "./pricing";
import { resolveKeyForAccount } from "./accountKeyResolver";
import { previousImage } from "./imageRequest";
import { UserFacingError } from "../router/errors";

/**
 * Claude draws with code: it writes a Python script (Pillow, matplotlib,
 * numpy) and runs it in Anthropic's code-execution sandbox, which hands back
 * the file it saved. That makes it the only image option here that can make
 * animated GIFs, and it's strong at text, typography, charts, diagrams,
 * patterns and geometric or flat-style art. It can't make photos or painterly
 * images — the Gemini / OpenAI image models are for those.
 *
 * Like the other image adapters, the result is a markdown data-URI image that
 * the chat controller moves into object storage.
 */

const ID = "anthropic:claude-sonnet-5-5-image";
const MODEL = "claude-sonnet-5-5";
const MAX_OUTPUT_TOKENS = 16000;
/** Long sandbox runs pause; resume a few times before giving up. */
const MAX_CONTINUATIONS = 4;
/**
 * Every sandbox step re-reads the conversation, so a run that keeps
 * iterating gets expensive fast (one logo run hit $1.68). Past this, stop
 * resuming / don't ask for a retry, and use whatever image exists.
 */
const MAX_RUN_USD = 0.5;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/gif", "image/jpeg", "image/webp"]);

const SYSTEM_PROMPT = `You make images by writing and running Python in the code execution tool. Pillow, numpy and matplotlib are available; for text, use a TrueType font from the system (for example DejaVuSans / DejaVuSansMono from /usr/share/fonts), falling back to ImageFont.load_default(size=...) if none is found.

Rules:
- Produce exactly one final image file and save it in the directory named by the OUTPUT_DIR environment variable (e.g. os.path.join(os.environ["OUTPUT_DIR"], "final.png")) — only files saved there are delivered to the user, so put nothing else there. Use a PNG for a still image, or an animated GIF when the user asks for a GIF or animation (loop forever, smooth timing, keep it under about 5 MB).
- Default to 1024x1024 for stills unless the request implies another shape; GIFs around 640px wide.
- Make it look polished: deliberate colours, generous spacing, anti-aliased shapes, readable text.
- Work efficiently: aim for one script plus at most one fix-up run. Keep printed output short — never print image data, base64 or long file/font listings (pipe searches through head -5).
- Check your output once (dimensions, frame count, file size) and fix problems before finishing.
- If an input image is provided, edit that image rather than starting over, unless asked otherwise. It is in the directory named by the INPUT_DIR environment variable.
- When done, reply with one or two short sentences describing what the image shows. No code, file names, sizes, or notes about how you made or checked it.`;

async function getClient(accountId: string | null): Promise<Anthropic> {
  const apiKey = await resolveKeyForAccount(ID, "anthropic", "Anthropic", accountId);
  return new Anthropic({ apiKey });
}

function addUsage(total: TokenUsage, u: Anthropic.Usage): void {
  const cached = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  total.input_tokens += u.input_tokens + cached + written;
  total.output_tokens += u.output_tokens;
  total.cached_input_tokens = (total.cached_input_tokens ?? 0) + cached;
  total.cache_write_tokens = (total.cache_write_tokens ?? 0) + written;
}

/** Every file the sandbox returned, in order. */
function outputFileIds(content: Anthropic.ContentBlock[]): string[] {
  const ids: string[] = [];
  for (const block of content) {
    if (block.type !== "bash_code_execution_tool_result") continue;
    const result = block.content;
    if (result.type !== "bash_code_execution_result") continue;
    for (const ref of result.content) ids.push(ref.file_id);
  }
  return ids;
}

export const claudeImageAdapter: ProviderAdapter = {
  id: ID,
  keyProviderId: "anthropic",
  cost: { kind: "tokens", model: MODEL, maxOutputTokens: MAX_OUTPUT_TOKENS },
  // Several sandbox steps, each re-reading the conversation: ~$0.05–0.50 a run.
  typicalUsd: 0.3,
  async call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse> {
    const startedAt = new Date();
    const client = await getClient(accountId);
    const uploaded: string[] = [];
    const produced: string[] = [];
    try {
      const earlier = await previousImage(request, accountId);
      const userContent: Anthropic.ContentBlockParam[] = [];
      if (earlier) {
        const extension = earlier.mimeType.split("/")[1] ?? "png";
        const file = await client.files.upload({
          file: await toFile(Buffer.from(earlier.data, "base64"), `input.${extension}`, { type: earlier.mimeType }),
        });
        uploaded.push(file.id);
        userContent.push({ type: "container_upload", file_id: file.id });
        if (earlier.mimeType !== "image/gif") {
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: earlier.mimeType as "image/png", data: earlier.data },
          });
        }
        userContent.push({ type: "text", text: `Input image: $INPUT_DIR/input.${extension} (the image from earlier in this chat).` });
      }
      userContent.push({ type: "text", text: request.input });

      const messages: Anthropic.MessageParam[] = [
        // Earlier turns as text, so references like "make it bigger" have context.
        ...(request.history ?? []).slice(-6).map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: userContent },
      ];
      const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
      let container: string | undefined;

      /** One Claude turn, resuming through pause_turn. */
      const runTurn = async (): Promise<Anthropic.Message> => {
        let response: Anthropic.Message | null = null;
        for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
          response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: SYSTEM_PROMPT,
            messages,
            tools: [{ type: "code_execution_20260120", name: "code_execution" }],
            ...(container ? { container } : {}),
          });
          addUsage(usage, response.usage);
          produced.push(...outputFileIds(response.content));
          container = response.container?.id ?? container;
          if (response.stop_reason !== "pause_turn") break;
          if (nativeCost(MODEL, usage, startedAt) > MAX_RUN_USD) break;
          messages.push({ role: "assistant", content: response.content });
        }
        if (!response) throw new Error("Claude returned no response");
        if (response.stop_reason === "refusal") {
          throw new UserFacingError("Claude declined to make this image. Try describing it differently.");
        }
        return response;
      };

      /** The last image file the sandbox handed back (the final one). */
      const seen: string[] = [];
      const latestImage = async (): Promise<{ mimeType: string; data: Buffer } | null> => {
        for (let i = produced.length - 1; i >= 0; i--) {
          const meta = await client.files.retrieveMetadata(produced[i]!);
          seen.push(`${meta.filename} (${meta.mime_type}, ${meta.size_bytes} B)`);
          if (!IMAGE_TYPES.has(meta.mime_type) || meta.size_bytes > MAX_IMAGE_BYTES) continue;
          const download = await client.files.download(produced[i]!);
          return { mimeType: meta.mime_type, data: Buffer.from(await download.arrayBuffer()) };
        }
        return null;
      };

      let response = await runTurn();
      let image = await latestImage();
      if (!image && container && nativeCost(MODEL, usage, startedAt) <= MAX_RUN_USD) {
        // Only files in $OUTPUT_DIR are handed back. If Claude saved the image
        // elsewhere (e.g. /tmp), the container still has it — ask once for a
        // copy where it's delivered.
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content:
            "The image file wasn't delivered — only files in $OUTPUT_DIR are. Run code that writes the final image to " +
            "$OUTPUT_DIR/final.png (or final.gif if it's animated): copy it there, or re-render it if it's gone. " +
            "Then reply with the same short description as before.",
        });
        response = await runTurn();
        image = await latestImage();
      }
      if (!image) {
        const blocks = response.content.map((b) => b.type).join(",");
        console.warn(
          `[claudeImage] no image file (stop=${response.stop_reason}; files=[${seen.join("; ")}]; blocks=${blocks})`
        );
        throw new UserFacingError(
          "Claude worked on the image but didn't finish a file this time. Please try again — a simpler description often helps."
        );
      }

      const caption = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n\n");
      const alt = request.input.replace(/[[\]\n]/g, " ").trim().slice(0, 120);
      const markdown = `![${alt}](data:${image.mimeType};base64,${image.data.toString("base64")})`;
      return {
        content: caption ? `${markdown}\n\n${caption}` : markdown,
        usage,
        // Sandbox time is billed separately by Anthropic at a few cents per
        // container-hour (after a monthly free allowance) — negligible per image.
        native_cost: nativeCost(MODEL, usage, startedAt),
      };
    } finally {
      // Files API storage isn't needed once the bytes are ours.
      await Promise.all(
        [...uploaded, ...produced].map((id) => client.files.delete(id).catch(() => undefined))
      );
    }
  },
  async streamCall(request: RouteRequest, _onDelta: (text: string) => void, accountId: string | null) {
    // Nothing useful to stream (the script runs server-side); the client
    // renders the stored image from the "done" event.
    return claudeImageAdapter.call(request, accountId);
  },
};
