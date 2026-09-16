/**
 * Hash an admin password with the same scrypt helper used at login.
 *
 * Usage:
 *   npx tsx scripts/hash-admin-password.ts 'YourNewPasswordHere'
 *
 * Paste the printed hash into:
 *   UPDATE admin_users SET password_hash = '<hash>', password_changed_at = now()
 *   WHERE username = 'system';
 */
import { hashPassword, validatePasswordPolicy } from "../src/shared/utils/password";

const password = process.argv[2] ?? "";
if (!password) {
  console.error("Usage: npx tsx scripts/hash-admin-password.ts '<password>'");
  process.exit(1);
}

const policyError = validatePasswordPolicy(password);
if (policyError) {
  console.error(`Password policy: ${policyError}`);
  process.exit(1);
}

process.stdout.write(`${hashPassword(password)}\n`);
