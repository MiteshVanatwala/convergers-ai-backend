import pino from "pino";

const appLogger = pino({ name: "convergers-backend" });

/** Log a caught error with a `[module.layer.fn]` scope prefix. Prefer this over console.error. */
export function logCaught(scope: string, error: unknown): void {
  const detail: string =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  appLogger.error({ err: error }, `[${scope}] ${detail}`);
}
