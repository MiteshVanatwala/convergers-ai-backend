import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { getStorage } from "../../infrastructure/storage/object-storage";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import { findAccountFileByKey, saveFile } from "../artifacts/files.service";
import { creditsForCost } from "../ledger/ledger.service";
import { getSpendable } from "../ledger/spend.service";
import * as usageService from "../usage/usage.service";
import {
  ACCEPTED_AUDIO_TYPES,
  GEMINI_VOICE,
  ORPHEUS_VOICE,
  estimateSpeechUsd,
  synthesize,
  transcribe,
  type ProviderResult,
} from "./voice.providers";

/** Charged per request on the account's own provider key (the provider bills them directly). */
const BYOK_VOICE_CREDITS = 1;
/** One chunk of an answer; the client splits longer answers and plays them in order. */
export const MAX_SPEECH_CHARS = 2000;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
/** Bumped when the voice or provider order changes, so cached audio is regenerated. */
const SPEECH_CACHE_VERSION = `v1:${GEMINI_VOICE}:${ORPHEUS_VOICE}`;

async function bill(accountId: string, result: ProviderResult<object>, fallbackUsed: boolean): Promise<number> {
  const { charged } = await usageService.recordSuccessAndDebit({
    accountId,
    taskType: "voice",
    provider: result.provider,
    tokensInput: result.inputUnits,
    tokensOutput: result.outputUnits,
    nativeCost: result.nativeCost,
    creditsRequested: result.byok ? BYOK_VOICE_CREDITS : creditsForCost(result.nativeCost),
    fallbackUsed,
  });
  return charged;
}

/** POST /v1/voice/transcribe — body is the raw recording (audio/webm, audio/mp4, …). */
export async function transcribeAudio(
  request: FastifyRequest<{ Querystring: { language?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const contentType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ACCEPTED_AUDIO_TYPES.includes(contentType)) {
      return fail(reply, AppStatus.VOICE_VALIDATION_FAILED, "Unsupported audio format", 415);
    }
    const audio = request.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return fail(reply, AppStatus.VOICE_VALIDATION_FAILED, "No audio received", 400);
    }
    const language = /^[a-z]{2}$/.test(request.query.language ?? "") ? request.query.language : undefined;

    const { balance } = await getSpendable(account.id);
    if (balance < 1) {
      return fail(reply, AppStatus.VOICE_INSUFFICIENT_CREDITS, "You're out of credits. Buy more to use voice.", 402);
    }

    let result: Awaited<ReturnType<typeof transcribe>>;
    try {
      result = await transcribe(audio, contentType, account.id, language);
    } catch (error: unknown) {
      logCaught("voice.controller.transcribeAudio.provider", error);
      return fail(reply, AppStatus.VOICE_UNAVAILABLE, "Voice input isn't available right now. Please type instead.", 503);
    }
    const creditsCharged = await bill(account.id, result, result.provider !== "groq:whisper-large-v3-turbo");
    return ok(reply, AppStatus.VOICE_TRANSCRIBED, {
      text: result.text,
      language: result.language,
      durationSeconds: Math.round(result.durationSeconds * 10) / 10,
      creditsCharged,
    });
  } catch (error: unknown) {
    logCaught("voice.controller.transcribeAudio", error);
    return fail(reply, AppStatus.VOICE_FAILED, "Couldn't transcribe that recording. Please try again.", 500);
  }
}

function sendWav(reply: FastifyReply, wav: Buffer | NodeJS.ReadableStream, size: number | null, credits: number) {
  reply.header("Content-Type", "audio/wav");
  reply.header("Cache-Control", "private, no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Credits-Charged", String(credits));
  reply.header("Access-Control-Expose-Headers", "X-Credits-Charged");
  if (size !== null) reply.header("Content-Length", String(size));
  return reply.send(wav);
}

/** POST /v1/voice/speak {text} — returns audio/wav. Repeat requests for the same text are free. */
export async function speakText(request: FastifyRequest<{ Body: { text?: unknown } }>, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text) return fail(reply, AppStatus.VOICE_VALIDATION_FAILED, "Nothing to read aloud", 400);
    if (text.length > MAX_SPEECH_CHARS) {
      return fail(reply, AppStatus.VOICE_VALIDATION_FAILED, `Send at most ${MAX_SPEECH_CHARS} characters at a time`, 400);
    }

    const hash = createHash("sha256").update(`${SPEECH_CACHE_VERSION}\n${text}`).digest("hex");
    const key = `audio/${account.id}/${hash}.wav`;
    const cached = await findAccountFileByKey(account.id, key);
    if (cached) {
      const object = await getStorage().get(cached.storage_key);
      if (object) return sendWav(reply, object.body, object.size, 0);
    }

    const { balance } = await getSpendable(account.id);
    if (balance < creditsForCost(estimateSpeechUsd(text))) {
      return fail(reply, AppStatus.VOICE_INSUFFICIENT_CREDITS, "You're out of credits. Buy more to use voice.", 402);
    }

    let result: Awaited<ReturnType<typeof synthesize>>;
    try {
      result = await synthesize(text, account.id);
    } catch (error: unknown) {
      logCaught("voice.controller.speakText.provider", error);
      // The client falls back to the browser's own voice on this status.
      return fail(reply, AppStatus.VOICE_UNAVAILABLE, "Read-aloud isn't available right now.", 503);
    }
    const creditsCharged = await bill(account.id, result, result.provider !== "gemini:gemini-3.8-flash-tts");
    if (!cached) {
      await saveFile({ accountId: account.id, kind: "audio", key, body: result.wav, contentType: "audio/wav" }).catch(
        (error: unknown) => logCaught("voice.controller.speakText.cache", error)
      );
    }
    return sendWav(reply, result.wav, result.wav.length, creditsCharged);
  } catch (error: unknown) {
    logCaught("voice.controller.speakText", error);
    return fail(reply, AppStatus.VOICE_FAILED, "Couldn't read that aloud. Please try again.", 500);
  }
}
