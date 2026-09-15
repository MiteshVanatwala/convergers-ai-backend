import type { FastifyReply } from "fastify";
import type { AppStatusCode } from "../../config/app-status-codes";
import type { ApiErrorEnvelope, ApiSuccessEnvelope } from "../types/api-envelope";

export function ok<T>(
  reply: FastifyReply,
  statusCode: AppStatusCode,
  data: T,
  httpStatus: number = 200
): FastifyReply {
  const body: ApiSuccessEnvelope<T> = {
    success: true,
    status_code: statusCode,
    data,
  };
  return reply.status(httpStatus).send(body);
}

export function fail(
  reply: FastifyReply,
  statusCode: AppStatusCode,
  error: string,
  httpStatus: number = 400
): FastifyReply {
  const body: ApiErrorEnvelope = {
    success: false,
    status_code: statusCode,
    error,
  };
  return reply.status(httpStatus).send(body);
}
