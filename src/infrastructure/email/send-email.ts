import nodemailer, { type Transporter } from "nodemailer";
import { loadEnv } from "../../config/env";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; `text` is always sent too, for clients that don't render HTML. */
  html?: string;
  /** Replies go here instead of the sender address. */
  replyTo?: string;
};

type Provider = "smtp" | "resend";

function activeProvider(): Provider | null {
  const { email } = loadEnv();
  if (!email.from) return null;
  if (email.smtp.host && email.smtp.user && email.smtp.pass) return "smtp";
  if (email.resendApiKey) return "resend";
  return null;
}

/** True when a sender (EMAIL_FROM / SMTP_FROM) and a provider (SMTP or Resend) are configured. */
export function isEmailConfigured(): boolean {
  return activeProvider() !== null;
}

/** Which provider will send, for the admin setup checklist. */
export function emailProviderLabel(): string | null {
  const provider = activeProvider();
  if (provider === "smtp") return `SMTP (${loadEnv().email.smtp.host})`;
  if (provider === "resend") return "Resend";
  return null;
}

// One pooled SMTP connection per process, rebuilt if the config changes (dev reloads).
let smtpTransport: { key: string; transporter: Transporter } | null = null;

function getSmtpTransport(): Transporter {
  const { smtp } = loadEnv().email;
  const key = `${smtp.host}|${smtp.port}|${smtp.secure}|${smtp.user}`;
  if (smtpTransport?.key !== key) {
    smtpTransport = {
      key,
      transporter: nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        pool: true,
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
      }),
    };
  }
  return smtpTransport.transporter;
}

async function sendViaResend(message: OutgoingEmail, from: string, apiKey: string): Promise<void> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend rejected the email (${response.status}): ${detail.slice(0, 300)}`);
  }
}

/**
 * Sends one email through the configured provider (SMTP first, then Resend).
 * Throws when email isn't configured or the provider rejects it — callers
 * decide whether that should fail their operation.
 */
export async function sendEmail(message: OutgoingEmail): Promise<void> {
  const { email } = loadEnv();
  const provider = activeProvider();
  if (!provider || !email.from) {
    throw new Error("Email is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY, plus EMAIL_FROM)");
  }
  if (provider === "resend") {
    await sendViaResend(message, email.from, email.resendApiKey!);
    return;
  }
  await getSmtpTransport().sendMail({
    from: email.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  });
}
