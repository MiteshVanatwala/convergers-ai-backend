import { Resolver } from "dns/promises";
import { domainToASCII } from "url";
import { logCaught } from "../../shared/utils/log";
import { DISPOSABLE_DOMAINS, DISPOSABLE_DOMAINS_UPDATED_ON } from "./data/disposable-domains";
import { listEmailDomainRules } from "./email-domain-rules.service";

/**
 * Sign-up email policy: blocks throwaway inboxes (yopmail, temp-mail, …) that
 * are used to farm signup credits. Only new accounts are checked — existing
 * accounts keep signing in — except for admin block rules (isBlockedByAdminRule).
 *
 * 0. Admin rules (Admin → Email domains) win: 'allow' passes, 'block' blocks.
 * 1. The domain (or a parent of it) is on the bundled CC0 list.
 * 2. The domain's MX hosts belong to a listed/blocked domain or a known throwaway
 *    mail host — catches alias domains the list misses (they share the provider's MX).
 * 3. The domain can't receive mail at all (NXDOMAIN, null MX, no MX/A/AAAA).
 * DNS timeouts and errors fail open: a slow resolver never blocks a real user.
 */
export type SignupEmailVerdict = "ok" | "disposable" | "no_mail";
export type SignupEmailReason =
  | "admin_allow"
  | "admin_block"
  | "list"
  | "mx"
  | "no_mail"
  | "passed"
  | "dns_unavailable"
  | "invalid";

const DISPOSABLE = new Set(DISPOSABLE_DOMAINS.split("\n").filter(Boolean));
export const DISPOSABLE_LIST_INFO = { size: DISPOSABLE.size, updatedOn: DISPOSABLE_DOMAINS_UPDATED_ON };

/** Mainstream providers that must never be blocked, whatever a list or rule says. */
export const MAINSTREAM_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
]);

// MX hosts that receive mail for 15+ listed throwaway domains but aren't on the
// list themselves (from an MX scan of the list, 2026-10-19). Shared providers
// (Cloudflare, Google, Mailgun, AWS, Namecheap, parking) are never added here.
const DISPOSABLE_MX_DOMAINS = new Set([
  "chatgpt.org.uk",
  "wallywatts.com",
  "wabblywabble.com",
  "tinyhost.shop",
  "casadorock.com",
  "oneb.net",
  "tempmail.tw",
  "erinn.biz",
  "tempm.com",
  "eye-mail.net",
  "cleantempmail.com",
]);

const DNS_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;
const RULES_TTL_MS = 60 * 1000;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type MxResult = { verdict: SignupEmailVerdict; reason: SignupEmailReason };
const mxCache = new Map<string, MxResult & { expiresAt: number }>();

type Rules = { block: Set<string>; allow: Set<string> };
let rules: Rules = { block: new Set(), allow: new Set() };
let rulesLoadedAt = 0;

/** Lowercase ASCII (punycode) domain of an email, or "" when it can't be parsed. */
export function emailDomain(email: string): string {
  const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
  return domain ? domainToASCII(domain) : "";
}

/** Normalizes an admin-entered domain ("@Mail.Example.com." → "mail.example.com"); null if invalid. */
export function normalizeRuleDomain(raw: string): string | null {
  const domain = emailDomain(`x@${raw.trim().replace(/^@/, "")}`);
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

/** Call after an admin changes a rule so this process applies it immediately. */
export function invalidateEmailDomainRules(): void {
  rulesLoadedAt = 0;
  mxCache.clear();
}

/** Admin rules, cached for a minute. A failed load keeps the last good rules (fail open). */
async function loadRules(): Promise<Rules> {
  if (Date.now() - rulesLoadedAt < RULES_TTL_MS) return rules;
  try {
    const rows = await listEmailDomainRules();
    rules = {
      block: new Set(rows.filter((r) => r.action === "block").map((r) => r.domain)),
      allow: new Set(rows.filter((r) => r.action === "allow").map((r) => r.domain)),
    };
  } catch (error: unknown) {
    logCaught("auth.email-policy.loadRules", error);
  }
  rulesLoadedAt = Date.now();
  return rules;
}

/** True when the domain or any parent domain (x.yopmail.com → yopmail.com) is in `set`. */
function matchesDomainOrParent(domain: string, set: Set<string>): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** Verdict from the rules and the bundled list alone (no DNS); null = not decided. */
function listVerdict(domain: string, current: Rules): MxResult | null {
  if (matchesDomainOrParent(domain, current.allow)) return { verdict: "ok", reason: "admin_allow" };
  if (MAINSTREAM_EMAIL_DOMAINS.has(domain)) return null;
  if (matchesDomainOrParent(domain, current.block)) return { verdict: "disposable", reason: "admin_block" };
  if (matchesDomainOrParent(domain, DISPOSABLE)) return { verdict: "disposable", reason: "list" };
  return null;
}

function isDisposableMxHost(host: string, current: Rules): boolean {
  return (
    matchesDomainOrParent(host, DISPOSABLE) ||
    matchesDomainOrParent(host, DISPOSABLE_MX_DOMAINS) ||
    matchesDomainOrParent(host, current.block)
  );
}

function dnsCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

async function hasAddressRecord(resolver: Resolver, domain: string): Promise<boolean> {
  const results = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  return results.some((r) => r.status === "fulfilled" && r.value.length > 0);
}

/** MX-based verdict, or null when DNS couldn't answer (fail open, not cached). */
async function checkMx(domain: string, current: Rules): Promise<MxResult | null> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  try {
    const records = await resolver.resolveMx(domain);
    const hosts = records.map((r) => r.exchange.toLowerCase().replace(/\.$/, "")).filter(Boolean);
    // RFC 7505 null MX ("0 .") — the domain explicitly accepts no mail.
    if (hosts.length === 0) return { verdict: "no_mail", reason: "no_mail" };
    return hosts.some((host) => isDisposableMxHost(host, current))
      ? { verdict: "disposable", reason: "mx" }
      : { verdict: "ok", reason: "passed" };
  } catch (error: unknown) {
    const code = dnsCode(error);
    if (code === "ENOTFOUND") return { verdict: "no_mail", reason: "no_mail" };
    // No MX: mail falls back to the A/AAAA record (RFC 5321 §5.1).
    if (code === "ENODATA") {
      return (await hasAddressRecord(resolver, domain))
        ? { verdict: "ok", reason: "passed" }
        : { verdict: "no_mail", reason: "no_mail" };
    }
    logCaught("auth.email-policy.checkMx", error);
    return null;
  }
}

/** The verdict plus which check decided it — for Admin → Email domains "Test an address". */
export async function explainSignupEmail(email: string): Promise<MxResult & { domain: string }> {
  const domain = emailDomain(email);
  if (!domain || !DOMAIN_RE.test(domain)) return { domain, verdict: "no_mail", reason: "invalid" };
  const current = await loadRules();
  const decided = listVerdict(domain, current);
  if (decided) return { domain, ...decided };

  const cached = mxCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return { domain, verdict: cached.verdict, reason: cached.reason };

  const result = await checkMx(domain, current);
  if (!result) return { domain, verdict: "ok", reason: "dns_unavailable" };
  if (mxCache.size >= CACHE_MAX) mxCache.clear();
  mxCache.set(domain, { ...result, expiresAt: Date.now() + CACHE_TTL_MS });
  return { domain, ...result };
}

/**
 * True when an admin block rule covers this email's domain (and no allow rule does).
 * Unlike the list/MX checks this also applies to existing accounts: no sign-in, sessions end.
 */
export async function isBlockedByAdminRule(email: string): Promise<boolean> {
  return listVerdict(emailDomain(email), await loadRules())?.reason === "admin_block";
}

/** Decides whether a new account may sign up with this (already normalized) email. */
export async function checkSignupEmail(email: string): Promise<SignupEmailVerdict> {
  return (await explainSignupEmail(email)).verdict;
}

/** Sync "known throwaway domain" check (rules + list, no DNS) for listing many accounts at once. */
export async function disposableEmailChecker(): Promise<(email: string) => boolean> {
  const current = await loadRules();
  return (email: string) => listVerdict(emailDomain(email), current)?.verdict === "disposable";
}
