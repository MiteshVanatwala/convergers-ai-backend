import { hasOwnKey, resolveKeyForAccount } from "../brain/adapters/accountKeyResolver";
import { buildWav, joinWavs, wavDurationSeconds } from "./wav";

/**
 * Speech providers, called in order until one works (same idea as the
 * router's fallback chain, without the chat-specific parts).
 *
 *   Listen (speech → text): Groq Whisper large-v3 turbo, then large-v3.
 *   Talk back (text → speech): Gemini 3.8 Flash TTS (most languages), then
 *   Groq Orpheus (English only). If neither works the client falls back to
 *   the browser's built-in voice.
 *
 * Provider ids match provider_registry rows (db/voice_v1.sql), which is what
 * the plan check in resolveKeyForAccount looks up.
 */

export type ProviderResult<T> = T & {
  provider: string;
  /** USD cost of the call (0 is fine; billing rounds up to at least 1 credit). */
  nativeCost: number;
  /** Ran on the account's own provider key. */
  byok: boolean;
  inputUnits: number;
  outputUnits: number;
};

const GROQ = "https://api.groq.com/openai/v1";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

// ---------- listen ----------

/** Groq bills Whisper per hour of audio, with a 10-second minimum per request. */
const WHISPER = [
  { id: "groq:whisper-large-v3-turbo", model: "whisper-large-v3-turbo", usdPerHour: 0.04 },
  { id: "groq:whisper-large-v3", model: "whisper-large-v3", usdPerHour: 0.111 },
];
const WHISPER_MIN_SECONDS = 10;

/** Biases spelling toward words Whisper would otherwise miss. */
const VOCABULARY_HINT = "Aikya.";

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

export const ACCEPTED_AUDIO_TYPES = Object.keys(EXTENSIONS);

export async function transcribe(
  audio: Buffer,
  contentType: string,
  accountId: string,
  language?: string
): Promise<ProviderResult<{ text: string; language: string | null; durationSeconds: number }>> {
  const extension = EXTENSIONS[contentType] ?? "webm";
  let lastError: unknown;
  for (const option of WHISPER) {
    try {
      const apiKey = await resolveKeyForAccount(option.id, "groq", "Groq", accountId);
      const form = new FormData();
      form.append("model", option.model);
      form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), `speech.${extension}`);
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      form.append("prompt", VOCABULARY_HINT);
      if (language) form.append("language", language);
      const res = await fetch(`${GROQ}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`Whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { text?: string; language?: string; duration?: number };
      const durationSeconds = json.duration ?? 0;
      return {
        text: (json.text ?? "").trim(),
        language: json.language ?? null,
        durationSeconds,
        provider: option.id,
        nativeCost: (Math.max(durationSeconds, WHISPER_MIN_SECONDS) / 3600) * option.usdPerHour,
        byok: await hasOwnKey("groq", accountId),
        inputUnits: Math.round(durationSeconds),
        outputUnits: 0,
      };
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No speech-to-text provider available");
}

// ---------- talk back ----------

/** Gemini TTS list prices go up on 2027-01-01 (https://ai.google.dev/gemini-api/docs/pricing). */
function geminiTtsRates(now = Date.now()): { inputPerToken: number; audioPerToken: number } {
  return now >= Date.UTC(2027, 0, 1)
    ? { inputPerToken: 1e-6, audioPerToken: 18e-6 }
    : { inputPerToken: 0.5e-6, audioPerToken: 9e-6 };
}

/** Gemini audio output runs at ~25 tokens per second. */
const GEMINI_AUDIO_TOKENS_PER_SECOND = 25;
/** Orpheus: $22 per million characters, at most 200 characters per request, English only. */
const ORPHEUS_USD_PER_CHAR = 22e-6;
const ORPHEUS_MAX_CHARS = 200;
const ORPHEUS_PARALLEL = 3;

export const GEMINI_VOICE = "Kore";
export const ORPHEUS_VOICE = "hannah";

/** Rough upper bound for the affordability check, before any call is made. */
export function estimateSpeechUsd(text: string): number {
  const seconds = text.length / 12; // ~12 spoken characters per second
  const { inputPerToken, audioPerToken } = geminiTtsRates();
  return (text.length / 3) * inputPerToken + seconds * GEMINI_AUDIO_TOKENS_PER_SECOND * audioPerToken;
}

async function geminiSpeech(text: string, accountId: string): Promise<ProviderResult<{ wav: Buffer }>> {
  const id = "gemini:gemini-3.8-flash-tts";
  const apiKey = await resolveKeyForAccount(id, "gemini", "Google Gemini", accountId);
  const res = await fetch(`${GEMINI}/gemini-3.8-flash-tts:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const audio = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!audio) throw new Error("Gemini TTS returned no audio");
  // Raw 16-bit PCM, e.g. "audio/L16;codec=pcm;rate=24000".
  const sampleRate = Number(audio.mimeType.match(/rate=(\d+)/)?.[1] ?? 24000);
  const wav = buildWav(Buffer.from(audio.data, "base64"), { sampleRate, channels: 1, bitsPerSample: 16 });
  const inputTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const audioTokens =
    json.usageMetadata?.candidatesTokenCount ?? Math.ceil(wavDurationSeconds(wav) * GEMINI_AUDIO_TOKENS_PER_SECOND);
  const rates = geminiTtsRates();
  return {
    wav,
    provider: id,
    nativeCost: inputTokens * rates.inputPerToken + audioTokens * rates.audioPerToken,
    byok: await hasOwnKey("gemini", accountId),
    inputUnits: inputTokens,
    outputUnits: audioTokens,
  };
}

/** Splits at sentence ends, then commas, then spaces, so no piece is over `max` characters. */
export function splitForSpeech(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const sentence = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n")
    );
    const comma = window.lastIndexOf(", ");
    const space = window.lastIndexOf(" ");
    const cut = sentence > 0 ? sentence + 1 : comma > 0 ? comma + 1 : space > 0 ? space : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/** Orpheus only speaks English; skip it for text that is mostly another script. */
function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const latin = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;
  return latin / letters.length > 0.9;
}

async function orpheusSpeech(text: string, accountId: string): Promise<ProviderResult<{ wav: Buffer }>> {
  const id = "groq:orpheus-v1-english";
  if (!looksEnglish(text)) throw new Error("Orpheus is English-only");
  const apiKey = await resolveKeyForAccount(id, "groq", "Groq", accountId);
  const pieces = splitForSpeech(text, ORPHEUS_MAX_CHARS);
  const wavs: Buffer[] = new Array(pieces.length);
  for (let i = 0; i < pieces.length; i += ORPHEUS_PARALLEL) {
    await Promise.all(
      pieces.slice(i, i + ORPHEUS_PARALLEL).map(async (piece, j) => {
        const res = await fetch(`${GROQ}/audio/speech`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "canopylabs/orpheus-v1-english",
            input: piece,
            voice: ORPHEUS_VOICE,
            response_format: "wav",
          }),
        });
        if (!res.ok) throw new Error(`Orpheus ${res.status}: ${(await res.text()).slice(0, 200)}`);
        wavs[i + j] = Buffer.from(await res.arrayBuffer());
      })
    );
  }
  return {
    wav: wavs.length === 1 ? wavs[0]! : joinWavs(wavs),
    provider: id,
    nativeCost: text.length * ORPHEUS_USD_PER_CHAR,
    byok: await hasOwnKey("groq", accountId),
    inputUnits: text.length,
    outputUnits: 0,
  };
}

export async function synthesize(text: string, accountId: string): Promise<ProviderResult<{ wav: Buffer }>> {
  let lastError: unknown;
  for (const speak of [geminiSpeech, orpheusSpeech]) {
    try {
      return await speak(text, accountId);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No text-to-speech provider available");
}
