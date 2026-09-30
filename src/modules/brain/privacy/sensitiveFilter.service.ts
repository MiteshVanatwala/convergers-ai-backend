import type { QueryResult } from "pg";
import { getPool } from "../../../infrastructure/db/pool";
import { findSensitiveSpans } from "./detectors";

/**
 * Per-account opt-in privacy layer: redact sensitive spans before a message
 * reaches any provider, restore them in the response before the user sees
 * it. Wired in at brain/index.ts, not the router — this needs to run
 * regardless of which provider ends up serving the request.
 *
 * Detection is local (see detectors.ts) — text is never sent to a model just
 * to be scanned, so unredacted input doesn't leave our servers.
 */

export type RedactionResult = {
  /** Redacted copies of the input texts, same order and length. */
  redactedTexts: string[];
  /** placeholder ("[REDACT_1]") -> original sensitive value */
  map: Map<string, string>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redacts every text (current message + prior turns) together so the same
 * value gets the same placeholder everywhere — and a value detected in one
 * turn is masked in every turn, even where its context keyword is missing.
 */
export function detectAndRedact(texts: string[]): RedactionResult {
  const values = new Set<string>();
  for (const text of texts) {
    for (const span of findSensitiveSpans(text)) values.add(span.value);
  }

  const map = new Map<string, string>();
  if (values.size === 0) {
    return { redactedTexts: [...texts], map };
  }

  // Longest first so a short match can't win over a longer one that contains it.
  const uniqueValues = [...values].sort((a, b) => b.length - a.length);
  const placeholderFor = new Map<string, string>();
  uniqueValues.forEach((value, i) => {
    const placeholder = `[REDACT_${i + 1}]`;
    placeholderFor.set(value, placeholder);
    map.set(placeholder, value);
  });

  // Single pass, so a short value can never match inside an already-inserted placeholder.
  const pattern = new RegExp(uniqueValues.map(escapeRegExp).join("|"), "g");
  const redactedTexts = texts.map((text) =>
    text.replace(pattern, (match) => placeholderFor.get(match) ?? match)
  );

  return { redactedTexts, map };
}

export function restoreSensitiveData(text: string, map: Map<string, string>): string {
  let restored = text;
  for (const [placeholder, original] of map) {
    restored = restored.split(placeholder).join(original);
  }
  return restored;
}

export async function isSensitiveFilterEnabled(accountId: string): Promise<boolean> {
  const pool = getPool();
  const result: QueryResult<{ filter_sensitive_data: boolean }> = await pool.query(
    `SELECT filter_sensitive_data FROM personalization_settings WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0]?.filter_sensitive_data ?? false;
}
