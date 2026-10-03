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
  /** Distinct masked values per kind (e.g. { email: 2, aadhaar: 1 }) — for reporting; never the values. */
  typeCounts: Record<string, number>;
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
  // value → kind of the first detection, so each distinct value counts once.
  const typeByValue = new Map<string, string>();
  for (const text of texts) {
    for (const span of findSensitiveSpans(text)) {
      if (!typeByValue.has(span.value)) typeByValue.set(span.value, span.type);
    }
  }
  const values = new Set(typeByValue.keys());
  const typeCounts: Record<string, number> = {};
  for (const type of typeByValue.values()) typeCounts[type] = (typeCounts[type] ?? 0) + 1;

  const map = new Map<string, string>();
  if (values.size === 0) {
    return { redactedTexts: [...texts], map, typeCounts };
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

  return { redactedTexts, map, typeCounts };
}

export function restoreSensitiveData(text: string, map: Map<string, string>): string {
  let restored = text;
  for (const [placeholder, original] of map) {
    restored = restored.split(placeholder).join(original);
  }
  return restored;
}

/** On if the user turned it on, or their organization requires it for every member. */
export async function isSensitiveFilterEnabled(accountId: string): Promise<boolean> {
  const pool = getPool();
  const result: QueryResult<{ enabled: boolean }> = await pool.query(
    `SELECT COALESCE(ps.filter_sensitive_data, false)
            OR COALESCE(o.enforce_sensitive_filter, false) AS enabled
     FROM (SELECT $1::text AS account_id) me
     LEFT JOIN personalization_settings ps ON ps.account_id::text = me.account_id
     LEFT JOIN organization_members m ON m.account_id::text = me.account_id
     LEFT JOIN organizations o ON o.id = m.org_id`,
    [accountId]
  );
  return result.rows[0]?.enabled ?? false;
}
