import { loadEnv, primaryWebOrigin } from "../../config/env";
import type { GoogleUserInfo } from "./types";

const GOOGLE_FETCH_TIMEOUT_MS = 10_000;

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webOrigin: string;
};

export function requireGoogleConfig(): GoogleOAuthConfig {
  const env = loadEnv();
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new Error("google_oauth_not_configured");
  }
  return {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
    webOrigin: primaryWebOrigin(env),
  };
}

export function buildGoogleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

export async function exchangeCodeForAccessToken(
  code: string,
  config: GoogleOAuthConfig
): Promise<{ accessToken: string } | { error: string }> {
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenJson.access_token) {
      return { error: tokenJson.error ?? "exchange_failed" };
    }
    return { accessToken: tokenJson.access_token };
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return { error: "exchange_failed" };
    }
    throw error;
  }
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  try {
    const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (!profileRes.ok) return null;
    return (await profileRes.json()) as GoogleUserInfo;
  } catch (error: unknown) {
    if (isAbortError(error)) return null;
    throw error;
  }
}
