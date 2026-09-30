/**
 * Provider errors carry raw upstream detail (org ids, billing links, request
 * payload hints) that must never reach end users. Anything thrown out of the
 * Brain is either a `UserFacingError` (message written for the user) or gets
 * the generic message below at the controller.
 */

export class UserFacingError extends Error {
  /** Machine-readable reason clients can act on (e.g. open the buy-credits UI). */
  readonly code?: string;

  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options);
    this.name = "UserFacingError";
    this.code = options?.code;
  }
}

export const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";

export const GENERIC_FAILURE_MESSAGE =
  "Something went wrong while generating a response. Please try again.";

/**
 * Safe `{ message, code? }` body for SSE `error` events and JSON error
 * responses — full error detail stays in server logs.
 */
export function userFacingPayload(err: unknown): { message: string; code?: string } {
  if (err instanceof UserFacingError) {
    return err.code ? { message: err.message, code: err.code } : { message: err.message };
  }
  return { message: GENERIC_FAILURE_MESSAGE };
}

/** HTTP status from an OpenAI/Anthropic SDK APIError (or anything shaped like one). */
function providerStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function isConnectionError(err: unknown): boolean {
  return err instanceof Error && /connection|timeout|ECONNRESET|ENOTFOUND|fetch failed/i.test(`${err.name} ${err.message}`);
}

/** Rate / capacity limits (429, Anthropic's 529 "overloaded") — worth trying another model. */
export function isCapacityError(err: unknown): boolean {
  const status = providerStatus(err);
  return status === 429 || status === 529;
}

/** Friendly explanation of why `label` failed. Passes UserFacingErrors through unchanged. */
export function describeProviderFailure(err: unknown, label: string): UserFacingError {
  if (err instanceof UserFacingError) return err;

  const status = providerStatus(err);
  let message: string;
  if (status === 429 || status === 529) {
    message = `${label} is at its usage limit right now. Try again in a minute, or switch to Auto.`;
  } else if (status === 401 || status === 403) {
    message =
      `${label} rejected the API key it was called with. If you added your own key for it in ` +
      `Settings → API Keys, check that it's still valid.`;
  } else if (status === 400 || status === 404 || status === 413 || status === 422) {
    message = `${label} couldn't handle this request. Try rephrasing it, or pick another model.`;
  } else if ((status !== undefined && status >= 500) || isConnectionError(err)) {
    message = `${label} is having trouble right now. Please try again shortly.`;
  } else {
    message = `${label} couldn't generate a response. Please try again.`;
  }
  return new UserFacingError(message, { cause: err });
}
