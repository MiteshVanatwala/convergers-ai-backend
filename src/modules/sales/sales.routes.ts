import type { FastifyInstance } from "fastify";
import * as salesController from "./sales.controller";

export function registerSalesRoutes(app: FastifyInstance): void {
  app.post<{ Body: salesController.SalesInquiryBody }>("/v1/sales/inquiries", (request, reply) =>
    salesController.createInquiry(request, reply)
  );
}
