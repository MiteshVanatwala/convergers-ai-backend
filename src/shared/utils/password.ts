import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** Encode a password as `scrypt$<salt>$<hash>` (base64url). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Verify a password against a stored `scrypt$…` hash. */
export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Unambiguous alphabet (no 0/O/I/l/1) for temporary admin passwords. */
const TEMP_PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Cryptographically strong temporary password for admin create/reset. */
export function generateTemporaryPassword(length: number = 20): string {
  const size = Math.min(Math.max(length, 10), 128);
  const bytes = randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i]! % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

/**
 * Admin password policy: 10–128 chars, at least one letter and one digit.
 * Returns an error message, or null if valid.
 */
export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 10) return "password must be at least 10 characters";
  if (password.length > 128) return "password must be at most 128 characters";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "password must include at least one letter and one digit";
  }
  return null;
}
