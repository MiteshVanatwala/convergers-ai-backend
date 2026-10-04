import type { FastifyInstance } from "fastify";
import * as voiceController from "./voice.controller";
import { MAX_AUDIO_BYTES } from "./voice.controller";

export function registerVoiceRoutes(app: FastifyInstance): void {
  // Encapsulated so the raw-audio body parser only applies to these routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) =>
      done(null, body)
    );

    scope.post<{ Querystring: { language?: string } }>(
      "/v1/voice/transcribe",
      { bodyLimit: MAX_AUDIO_BYTES },
      (request, reply) => voiceController.transcribeAudio(request, reply)
    );

    scope.post<{ Body: { text?: unknown } }>("/v1/voice/speak", (request, reply) =>
      voiceController.speakText(request, reply)
    );
  });
}
