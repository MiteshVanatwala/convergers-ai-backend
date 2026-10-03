import { loadEnv, primaryWebOrigin } from "../../config/env";
import { isEmailConfigured, sendEmail } from "../../infrastructure/email/send-email";
import { logCaught } from "../../shared/utils/log";
import * as notificationsService from "./notifications.service";
import type { Recipient } from "./notifications.service";

/**
 * Account lifecycle emails (welcome, plan changes). Every function here is
 * fire-and-forget: it never throws and never delays the request that
 * triggered it — a mail outage must not break sign-up or billing.
 */

// Higher = more paid. Free and Pay-as-you-go are both ₹0 upfront; PAYG ranks
// above Free only so Free → PAYG reads as a change, not a downgrade notice.
const PLAN_RANK: Record<string, number> = { free: 0, pay_as_you_go: 1, pro: 2 };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstName(recipient: Recipient): string {
  return recipient.name?.trim().split(/\s+/)[0] || "there";
}

/** Minimal, client-safe HTML: one column, inline styles, one button. */
type EmailContent = {
  greeting: string;
  paragraphs: string[];
  /** Shown large and spaced out, e.g. a sign-in code. */
  highlight?: string;
  /** Small print under the body. */
  footnote?: string;
  cta?: { label: string; url: string };
};

function renderHtml(input: EmailContent): string {
  const highlight = input.highlight
    ? `<p style="margin:6px 0 20px;padding:14px 0;border-radius:10px;background:#f7f4ef;text-align:center;font-size:30px;font-weight:700;letter-spacing:8px;color:#2b2420;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(input.highlight)}</p>`
    : "";
  const footnote = input.footnote
    ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#8a7f74">${escapeHtml(input.footnote)}</p>`
    : "";
  const body = input.paragraphs
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#2b2420">${escapeHtml(p)}</p>`)
    .join("");
  const cta = input.cta
    ? `<p style="margin:22px 0"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:11px 18px;border-radius:9px;background:#d9622b;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${escapeHtml(input.cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:28px;border-radius:14px;background:#ffffff;border:1px solid #ece6dd">
<p style="margin:0 0 18px;font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#2b2420">Aikya<span style="color:#d9622b">.</span></p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#2b2420">${escapeHtml(input.greeting)}</p>
${body}${highlight}${footnote}${cta}
<p style="margin:22px 0 0;font-size:12px;color:#8a7f74">You're receiving this because of activity on your Aikya account.</p>
</div></body></html>`;
}

function renderText(input: EmailContent): string {
  return [
    input.greeting,
    "",
    ...input.paragraphs.flatMap((p) => [p, ""]),
    ...(input.highlight ? [input.highlight, ""] : []),
    ...(input.footnote ? [input.footnote, ""] : []),
    ...(input.cta ? [`${input.cta.label}: ${input.cta.url}`, ""] : []),
    "— Aikya",
  ].join("\n");
}

async function deliver(to: string, subject: string, content: EmailContent): Promise<void> {
  await sendEmail({ to, subject, text: renderText(content), html: renderHtml(content) });
}

function fireAndForget(label: string, task: () => Promise<void>): void {
  if (!isEmailConfigured()) return;
  void task().catch((error: unknown) => logCaught(`notifications.account-emails.${label}`, error));
}

/**
 * Sign-in code for email login. Unlike the others this one is awaited and
 * throws — the caller must tell the person if the code couldn't be sent.
 */
export async function sendLoginCodeEmail(email: string, code: string, ttlMinutes: number): Promise<void> {
  await deliver(email, `${code} is your Aikya sign-in code`, {
    greeting: "Hi,",
    paragraphs: ["Use this code to sign in to Aikya:"],
    highlight: code,
    footnote: `It expires in ${ttlMinutes} minutes and can be used once. If you didn't try to sign in, you can ignore this email — nobody can get in without the code.`,
  });
}

/** New account created (Google or email sign-up). */
export function sendWelcomeEmail(recipient: Recipient): void {
  fireAndForget("welcome", async () => {
    const credits = loadEnv().signupGrantCredits;
    await deliver(recipient.email, "Welcome to Aikya", {
      greeting: `Hi ${firstName(recipient)},`,
      paragraphs: [
        "Welcome to Aikya — one chat that routes every request to the model best suited for it.",
        credits > 0
          ? `Your account is on the Free plan with ${credits.toLocaleString("en-IN")} trial credits, so you can start right away.`
          : "Your account is on the Free plan, so you can start right away.",
        "When you need more, Pro and Pay-as-you-go are a click away under Plans.",
      ],
      cta: { label: "Start chatting", url: primaryWebOrigin() },
    });
  });
}

/**
 * Personal plan changed (upgrade, downgrade or switch). `fromKey` null =
 * unknown previous plan. No email when the plan didn't actually change.
 */
export function sendPlanChangeEmail(input: { accountId: string; fromKey: string | null; toKey: string }): void {
  if (input.fromKey === input.toKey) return;
  fireAndForget("planChange", async () => {
    const [recipient, toName, fromName] = await Promise.all([
      notificationsService.getAccountRecipient(input.accountId),
      notificationsService.getPlanDisplayName(input.toKey),
      input.fromKey ? notificationsService.getPlanDisplayName(input.fromKey) : Promise.resolve(null),
    ]);
    if (!recipient) return;

    const fromRank = input.fromKey ? (PLAN_RANK[input.fromKey] ?? 0) : 0;
    const toRank = PLAN_RANK[input.toKey] ?? 0;
    const upgrade = toRank > fromRank;
    const downgrade = toRank < fromRank;
    const settingsUrl = primaryWebOrigin();

    const subject = upgrade
      ? `You're now on ${toName}`
      : downgrade
        ? `Your plan changed to ${toName}`
        : `You've switched to ${toName}`;

    const paragraphs = upgrade
      ? [
          `Your Aikya account has been upgraded${fromName ? ` from ${fromName}` : ""} to ${toName}.`,
          input.toKey === "pro"
            ? "Your monthly credits are added to your balance each billing cycle. You can see your plan and invoices under Settings → Plan & billing."
            : "You can see your plan and invoices under Settings → Plan & billing.",
        ]
      : downgrade
        ? [
            `Your Aikya account has moved${fromName ? ` from ${fromName}` : ""} to ${toName}.`,
            "Any credits already in your balance stay there. If this wasn't expected — for example a payment didn't go through — you can upgrade again any time under Plans.",
          ]
        : [
            `Your Aikya account has switched${fromName ? ` from ${fromName}` : ""} to ${toName}.`,
            "Your existing credit balance carries over.",
          ];

    await deliver(recipient.email, subject, {
      greeting: `Hi ${firstName(recipient)},`,
      paragraphs,
      cta: { label: upgrade ? "Open Aikya" : "View plans", url: settingsUrl },
    });
  });
}

/** Org Team plan started or ended — goes to the org owner. */
export function sendTeamPlanEmail(input: { orgId: string; event: "activated" | "ended"; seats?: number }): void {
  fireAndForget("teamPlan", async () => {
    const owner = await notificationsService.getOrgOwnerRecipient(input.orgId);
    if (!owner) return;
    const activated = input.event === "activated";
    await deliver(
      owner.email,
      activated ? `${owner.orgName} is on the Team plan` : `${owner.orgName}'s Team plan has ended`,
      {
        greeting: `Hi ${firstName(owner)},`,
        paragraphs: activated
          ? [
              `${owner.orgName} is now on the Team plan${input.seats ? ` with ${input.seats} ${input.seats === 1 ? "seat" : "seats"}` : ""}. Shared credits have been added to your organization's pool.`,
              "Next step: invite your team from Settings → Organization.",
            ]
          : [
              `The Team plan for ${owner.orgName} has ended, so members are back on their own credits.`,
              "Any credits left in the shared pool are kept and become usable again when you renew from Settings → Organization.",
            ],
        cta: { label: activated ? "Invite your team" : "Renew Team plan", url: primaryWebOrigin() },
      }
    );
  });
}
