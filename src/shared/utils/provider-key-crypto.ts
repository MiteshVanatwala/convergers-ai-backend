import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Encrypts provider API keys at rest (provider_api_keys.encrypted_key).
// AES-256-GCM via Node's built-in crypto — same "no external secrets
// manager" convention as password.ts/admin-session-token.ts, just reversible
// (a provider key must be retrieved in plaintext to call the provider).
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = process.env.PROVIDER_KEY_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "PROVIDER_KEY_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` and add it to backend/.env"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("PROVIDER_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  }
  return key;
}

/** Stored layout: iv (12B) || authTag (16B) || ciphertext. */
export function encryptProviderKey(plaintext: string): Buffer {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptProviderKey(stored: Buffer): string {
  const key = loadKey();
  const iv = stored.subarray(0, IV_LEN);
  const authTag = stored.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ciphertext = stored.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
