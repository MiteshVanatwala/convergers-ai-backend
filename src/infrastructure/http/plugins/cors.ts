import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { loadEnv } from "../../../config/env";

export async function registerCors(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  await app.register(cors, {
    origin: [...env.webOrigins, ...env.adminOrigins],
    credentials: true,
  });
}
