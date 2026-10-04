/** Minimal PCM WAV helpers — enough to wrap raw TTS output and join WAV pieces. */

export type PcmFormat = { sampleRate: number; channels: number; bitsPerSample: number };

export function buildWav(pcm: Buffer, format: PcmFormat): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Reads the format and PCM samples out of a WAV file (walks the chunk list). */
export function parseWav(wav: Buffer): { format: PcmFormat; pcm: Buffer } {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let format: PcmFormat | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const declared = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Streamed WAVs may declare 0 / 0xFFFFFFFF for data; take the rest of the buffer.
    const size = id === "data" && (declared === 0 || start + declared > wav.length) ? wav.length - start : declared;
    if (id === "fmt ") {
      format = {
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before fmt chunk");
      return { format, pcm: wav.subarray(start, start + size) };
    }
    offset = start + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Joins WAV files of the same format into one. */
export function joinWavs(wavs: Buffer[]): Buffer {
  const parts = wavs.map(parseWav);
  const format = parts[0]!.format;
  for (const part of parts) {
    if (
      part.format.sampleRate !== format.sampleRate ||
      part.format.channels !== format.channels ||
      part.format.bitsPerSample !== format.bitsPerSample
    ) {
      throw new Error("Cannot join WAVs with different formats");
    }
  }
  return buildWav(Buffer.concat(parts.map((p) => p.pcm)), format);
}

export function wavDurationSeconds(wav: Buffer): number {
  const { format, pcm } = parseWav(wav);
  return pcm.length / ((format.sampleRate * format.channels * format.bitsPerSample) / 8);
}
