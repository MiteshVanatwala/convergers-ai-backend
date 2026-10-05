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

/** The caller aborted before any model produced output — nothing to save or bill. */
export class RequestStoppedError extends Error {
  constructor() {
    super("Request stopped by the caller");
    this.name = "RequestStoppedError";
  }
}

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

/** Message plus any structured body the SDK attached — where providers put the real reason. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? "");
  const body = (err as { error?: unknown }).error;
  return `${err.message} ${body ? JSON.stringify(body) : ""}`;
}

/**
 * The provider account behind the key can't serve requests at all — out of
 * credit, quota used up, project blocked, model terms not accepted. Nothing
 * the user can fix by rephrasing; usually ours to fix (or theirs, on BYOK).
 */
export function isProviderAccountError(err: unknown): boolean {
  if (err instanceof UserFacingError) return false;
  if (providerStatus(err) === 402) return true;
  return /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|billing|payment required|denied access|requires terms acceptance|model_terms_required|account (?:is |has been )?(?:suspended|disabled|deactivated)/i.test(
    errorText(err)
  );
}

/** No key for this provider on the server (master key missing). */
export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof Error && !(err instanceof UserFacingError) && /isn't configured/.test(err.message);
}

/**
 * A failure that's ours to fix (account, key or setup), not the request's or
 * a passing outage: provider account problems, a missing key, a rejected key.
 */
export function isServerSideSetupError(err: unknown): boolean {
  if (err instanceof UserFacingError) return false;
  const status = providerStatus(err);
  return isProviderAccountError(err) || isNotConfiguredError(err) || status === 401 || status === 403;
}

function isConnectionError(err: unknown): boolean {
  return err instanceof Error && /connection|timeout|ECONNRESET|ENOTFOUND|fetch failed/i.test(`${err.name} ${err.message}`);
}

/** Rate / capacity limits (429, Anthropic's 529 "overloaded") — worth trying another model. */
export function isCapacityError(err: unknown): boolean {
  const status = providerStatus(err);
  return status === 429 || status === 529;
}

/**
 * How a provider call failed, for the admin model-status board — or null when
 * the failure says nothing about the model's health (a message for the user,
 * such as a plan or credit limit, or a provider with no key configured).
 */
export function classifyModelFailure(
  err: unknown
): { kind: "rate_limited" | "auth" | "account" | "error"; status: number | null } | null {
  if (err instanceof UserFacingError) return null;
  if (isNotConfiguredError(err)) return null;
  const status = providerStatus(err) ?? null;
  if (isProviderAccountError(err)) return { kind: "account", status };
  if (status === 429 || status === 529) return { kind: "rate_limited", status };
  if (status === 401 || status === 403) return { kind: "auth", status };
  return { kind: "error", status };
}

/**
 * Friendly explanation of why `label` failed. Passes UserFacingErrors through
 * unchanged. `byok`: the call ran on the user's own key, so account problems
 * are theirs to fix rather than ours.
 */
export function describeProviderFailure(err: unknown, label: string, byok = false): UserFacingError {
  if (err instanceof UserFacingError) return err;

  const status = providerStatus(err);
  let message: string;
  if (isProviderAccountError(err)) {
    message = byok
      ? `${label} couldn't run on your own API key: that provider account is out of credit or blocked. ` +
        `Check its balance, or remove the key in Settings → API Keys to use ours.`
      : `${label} is unavailable right now because of a problem with our account at its provider — ` +
        `nothing to do with your request. Try another model, or try again later.`;
  } else if (isNotConfiguredError(err)) {
    message = `${label} isn't set up on this server yet. Pick another model, or use Auto.`;
  } else if (status === 429 || status === 529) {
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
