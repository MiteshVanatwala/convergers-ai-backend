import type { FastifyReply, FastifyRequest } from "fastify";

export async function health(_request: FastifyRequest, _reply: FastifyReply) {
  return { ok: true };
}
