import type { QueryResult } from "pg";
import { getPool } from "../../../infrastructure/db/pool";
import type { ProviderAdapter } from "../adapters/types";
import { haikuAdapter } from "../adapters/anthropic";
import { deepseekFlashAdapter } from "../adapters/deepseek";
import { glmAdapter } from "../adapters/glm";
import { kimiAdapter } from "../adapters/kimi";
import { qwenAdapter } from "../adapters/qwen";
import { gptOssAdapter } from "../adapters/gptOss";

/**
 * Per-account opt-in privacy layer: redact sensitive spans before a message
 * reaches any provider, restore them in the response before the user sees
 * it. Wired in at brain/index.ts, not the router — this needs to run
 * regardless of which provider ends up serving the request.
 */

// Same open-source-first, Anthropic-as-last-resort order as the main text
// routing chain (provider_routing_rules) — tried directly here (not via the
// router/walkChain) so this internal utility call stays outside normal
// billing/usage-event accounting, same as before. Called with accountId=null
// — this is an internal system step, not attributed to any end user, so it
// always uses the master key and skips both the own-key lookup and the
// plan-tier check (see accountKeyResolver.ts).
const DETECTION_CHAIN: ProviderAdapter[] = [
  deepseekFlashAdapter,
  glmAdapter,
  kimiAdapter,
  qwenAdapter,
  gptOssAdapter,
  haikuAdapter,
];

async function callDetectionModel(prompt: string): Promise<string> {
  let lastError: unknown;
  for (const adapter of DETECTION_CHAIN) {
    try {
      const response = await adapter.call({ input: prompt }, null);
      return response.content;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("no detection adapter available");
}

const DETECTION_PROMPT = `You are a data-loss-prevention scanner, not a conversational assistant.

Find every substring in the USER TEXT below that is one of these categories:
email address, phone number, physical/mailing address, government ID or SSN,
credit card number, API key/password/secret token, bank account or routing
number, date of birth.

Return ONLY a JSON array of the exact substrings found, copied verbatim from
the text (no paraphrasing, no explanation, no markdown). If none are found,
return [].

USER TEXT:
"""
`;

function extractJsonArray(raw: string): unknown {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON array found in detection output");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

export type RedactionResult = {
  redactedInput: string;
  /** placeholder ("[REDACT_1]") -> original sensitive value */
  map: Map<string, string>;
};

/** Returns null on any detection failure — caller must fail closed, never send unfiltered text. */
export async function detectAndRedact(input: string): Promise<RedactionResult | null> {
  let raw: string;
  try {
    raw = await callDetectionModel(`${DETECTION_PROMPT}${input}\n"""`);
  } catch {
    return null;
  }

  let spans: string[];
  try {
    const parsed: unknown = extractJsonArray(raw);
    if (!Array.isArray(parsed)) return null;
    spans = parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return null;
  }

  const map = new Map<string, string>();
  if (spans.length === 0) {
    return { redactedInput: input, map };
  }

  // Longest first so replacing a short match can't corrupt a longer one that contains it.
  const uniqueSpans = [...new Set(spans)].sort((a, b) => b.length - a.length);
  let redactedInput = input;
  uniqueSpans.forEach((span, i) => {
    if (!redactedInput.includes(span)) return; // detector hallucinated a span not actually in the text
    const placeholder = `[REDACT_${i + 1}]`;
    map.set(placeholder, span);
    redactedInput = redactedInput.split(span).join(placeholder);
  });

  return { redactedInput, map };
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
