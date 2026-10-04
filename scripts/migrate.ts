/**
 * Database migrations for backend/db/*.sql.
 *
 *   npm run db:status                 # check only: what's applied, what's pending
 *   npm run db:migrate                # apply pending migrations, in order
 *   npm run db:migrate -- --allow-destructive   # also allow files that drop data (see below)
 *
 * How it decides what's applied:
 *  - Applied migrations are recorded in the `schema_migrations` table.
 *  - A database set up before this script existed has no records yet, so each
 *    migration also has a `detect` query that checks for something it creates.
 *    Detected migrations are recorded ("detected") and NOT run again.
 *  - Everything else is pending and runs in the order of MIGRATIONS below.
 *
 * Adding a migration: put the .sql file in db/ and append it to MIGRATIONS
 * (with a `detect` query). The script refuses to run while db/ holds a file
 * that isn't listed, so nothing runs out of order.
 *
 * Files that destroy data (DROP TABLE …) are marked `destructive` and only run
 * when their tables are empty/absent, or with --allow-destructive.
 */
import "dotenv/config";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Client } from "pg";

type Migration = {
  file: string;
  /** SQL returning one row with a boolean column `applied`. */
  detect: string;
  /** Drops or rewrites tables; refuse when existing data would be lost. */
  destructive?: { guard: string; reason: string };
};

const table = (name: string) => `SELECT to_regclass('public.${name}') IS NOT NULL AS applied`;
const column = (tbl: string, col: string) =>
  `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = '${tbl}' AND column_name = '${col}') AS applied`;

/** Run order. Derived from each file's "Apply AFTER …" notes. New files go at the end. */
const MIGRATIONS: Migration[] = [
  { file: "schema.sql", detect: table("accounts") },
  { file: "rls.sql", detect: `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_account_id') AS applied` },
  { file: "google_auth.sql", detect: table("oauth_states") },
  { file: "admin_auth.sql", detect: table("admin_sessions") },
  { file: "admin_management.sql", detect: column("admin_users", "display_name") },
  { file: "commercial_plans_v1.sql", detect: `SELECT EXISTS (SELECT 1 FROM plans WHERE key = 'pay_as_you_go') AS applied` },
  {
    file: "account_plans_v1.sql",
    detect: `SELECT to_regclass('public.account_plans') IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM accounts a
                              WHERE NOT EXISTS (SELECT 1 FROM account_plans ap WHERE ap.account_id = a.id)) AS applied`,
  },
  { file: "projects_v1.sql", detect: column("projects", "updated_at") },
  {
    file: "conversations_messages_v1.sql",
    detect: column("conversations", "title_status"),
    destructive: {
      guard: `SELECT to_regclass('public.conversations') IS NOT NULL
                AND EXISTS (SELECT 1 FROM conversations) AS has_data`,
      reason: "drops and recreates conversations/messages — every existing chat would be deleted",
    },
  },
  {
    file: "conversations_recents_v1.sql",
    detect: `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_conversations_account_recents') AS applied`,
  },
  { file: "usage_events_partitions_v1.sql", detect: table("usage_events_2026_11") },
  { file: "provider_dynamic_config.sql", detect: table("provider_credentials") },
  { file: "provider_dynamic_config_v2.sql", detect: `SELECT EXISTS (SELECT 1 FROM provider_credentials WHERE id = 'openrouter') AS applied` },
  { file: "provider_dynamic_config_v3.sql", detect: column("provider_registry", "visible_to_users") },
  { file: "sensitive_data_filter_v1.sql", detect: column("personalization_settings", "filter_sensitive_data") },
  { file: "billing_plans_admin_v1.sql", detect: `SELECT EXISTS (SELECT 1 FROM permissions WHERE key = 'billing.manage_plans') AS applied` },
  { file: "plan_features_v1.sql", detect: table("feature_catalog") },
  { file: "provider_byok_tier_access_v1.sql", detect: table("provider_tier_access") },
  { file: "account_features_v1.sql", detect: table("account_features") },
  { file: "impersonation_v1.sql", detect: column("sessions", "impersonated_by") },
  {
    file: "provider_capabilities_v1.sql",
    detect: `SELECT NOT EXISTS (SELECT 1 FROM provider_registry WHERE capabilities = '[]'::jsonb) AS applied`,
  },
  { file: "recurring_credit_grants_v1.sql", detect: column("plans", "recurring_grant_credits") },
  { file: "razorpay_credit_purchases_v1.sql", detect: column("credit_purchases", "razorpay_payment_id") },
  { file: "plan_switching_v1.sql", detect: column("plans", "razorpay_plan_id") },
  { file: "pricing_v2.sql", detect: table("subscription_credit_grants") },
  { file: "partitions_v2.sql", detect: table("credit_ledger_default") },
  { file: "organizations_v1.sql", detect: table("org_invites") },
  { file: "organizations_v2.sql", detect: column("credit_purchases", "org_id") },
  { file: "organizations_v3.sql", detect: column("usage_events", "redacted_count") },
  { file: "pricing_v3.sql", detect: column("subscriptions", "unit_amount_paise") },
  { file: "organizations_v4.sql", detect: column("subscriptions", "pending_quantity") },
  { file: "invoices_v1.sql", detect: table("invoices") },
  { file: "seller_settings_v1.sql", detect: table("seller_settings") },
  { file: "billing_profiles_v2.sql", detect: column("billing_profiles", "postal_code") },
  { file: "auto_topup_v1.sql", detect: table("auto_topup_settings") },
  { file: "plan_features_v2.sql", detect: `SELECT EXISTS (SELECT 1 FROM feature_catalog WHERE key = 'shared_credit_pool') AS applied` },
  { file: "sales_inquiries_v1.sql", detect: table("sales_inquiries") },
  { file: "email_login_v1.sql", detect: table("email_login_codes") },
  {
    file: "models_2026_10.sql",
    detect: `SELECT EXISTS (SELECT 1 FROM provider_registry WHERE id = 'anthropic:claude-opus-5-5') AS applied`,
  },
  { file: "routing_costs_2026_10.sql", detect: table("model_call_failures") },
  {
    file: "remove_mistral.sql",
    detect: `SELECT NOT EXISTS (SELECT 1 FROM provider_credentials WHERE id = 'mistral') AS applied`,
  },
  { file: "artifacts_v1.sql", detect: table("artifacts") },
  {
    file: "images_v1.sql",
    detect: `SELECT EXISTS (SELECT 1 FROM provider_registry WHERE id = 'gemini:gemini-3.1-flash-image') AS applied`,
  },
  {
    file: "voice_v1.sql",
    detect: `SELECT EXISTS (SELECT 1 FROM provider_registry WHERE id = 'groq:whisper-large-v3-turbo') AS applied`,
  },
  {
    file: "images_v2.sql",
    detect: `SELECT EXISTS (SELECT 1 FROM provider_registry WHERE id = 'anthropic:claude-sonnet-5-5-image') AS applied`,
  },
];

const DB_DIR = join(__dirname, "..", "db");
const APPLY = process.argv.includes("--apply");
const ALLOW_DESTRUCTIVE = process.argv.includes("--allow-destructive");

type Status = "applied" | "detected" | "pending" | "changed" | "unlisted" | "missing";

const LABEL: Record<Status, string> = {
  applied: "applied",
  detected: "applied (not yet recorded)",
  pending: "PENDING",
  changed: "applied — file changed since",
  unlisted: "UNLISTED — add to MIGRATIONS",
  missing: "MISSING — listed but no file",
};

function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The SQL a Node client can run: drops psql meta-commands (`\c db`) and
 * CREATE DATABASE (this script creates the database itself).
 */
function runnableSql(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\\/.test(line) && !/^\s*CREATE DATABASE\b/i.test(line))
    .join("\n");
}

function hasOwnTransaction(sql: string): boolean {
  return /^\s*BEGIN\s*;/im.test(sql);
}

async function connectOrCreate(url: string): Promise<{ client: Client; created: boolean }> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return { client, created: false };
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code !== "3D000") throw error; // 3D000 = database does not exist
    const dbName = new URL(url).pathname.replace(/^\//, "");
    if (!APPLY) {
      console.log(`Database "${dbName}" doesn't exist yet — run "npm run db:migrate" to create it and apply everything.`);
      process.exit(0);
    }
    if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Refusing to create database with unusual name "${dbName}"`);
    const admin = new URL(url);
    admin.pathname = "/postgres";
    const adminClient = new Client({ connectionString: admin.toString() });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
    await adminClient.end();
    console.log(`Created database "${dbName}".`);
    const fresh = new Client({ connectionString: url });
    await fresh.connect();
    return { client: fresh, created: true };
  }
}

async function detectApplied(client: Client, m: Migration): Promise<boolean> {
  // A detect query can fail when the tables it inspects don't exist yet — that means "not applied".
  await client.query("SAVEPOINT detect");
  try {
    const result = await client.query<{ applied: boolean }>(m.detect);
    await client.query("RELEASE SAVEPOINT detect");
    return result.rows[0]?.applied === true;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT detect");
    return false;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (backend/.env).");
    process.exit(1);
  }
  const { client } = await connectOrCreate(url);

  try {
    // Status mode changes nothing — the tracking table is only created when applying.
    if (APPLY) {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        method      text NOT NULL CHECK (method IN ('ran', 'detected')),
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    }
    const tracked = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`
    );
    const recordedRows = tracked.rows[0]?.exists
      ? await client.query<{ filename: string; checksum: string }>(`SELECT filename, checksum FROM schema_migrations`)
      : { rows: [] as { filename: string; checksum: string }[] };
    const recorded = new Map(recordedRows.rows.map((r) => [r.filename, r.checksum]));

    // Work out each migration's status (detect queries run in one read-only transaction).
    const listed = new Set(MIGRATIONS.map((m) => m.file));
    const onDisk = readdirSync(DB_DIR).filter((f) => f.endsWith(".sql"));
    const unlisted = onDisk.filter((f) => !listed.has(f));

    const rows: { m: Migration; status: Status; sum: string }[] = [];
    await client.query("BEGIN READ ONLY");
    for (const m of MIGRATIONS) {
      const path = join(DB_DIR, m.file);
      if (!existsSync(path)) {
        rows.push({ m, status: "missing", sum: "" });
        continue;
      }
      const sum = checksum(readFileSync(path, "utf8"));
      const prev = recorded.get(m.file);
      if (prev) rows.push({ m, status: prev === sum ? "applied" : "changed", sum });
      else rows.push({ m, status: (await detectApplied(client, m)) ? "detected" : "pending", sum });
    }
    await client.query("ROLLBACK");

    // Report.
    const width = Math.max(...MIGRATIONS.map((m) => m.file.length), ...unlisted.map((f) => f.length));
    console.log(`\nMigrations in db/ (${new URL(url).pathname.slice(1)}):\n`);
    rows.forEach(({ m, status }, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${m.file.padEnd(width)}  ${LABEL[status]}`);
    });
    unlisted.forEach((f) => console.log(`   -  ${f.padEnd(width)}  ${LABEL.unlisted}`));

    const pending = rows.filter((r) => r.status === "pending");
    const detected = rows.filter((r) => r.status === "detected");
    const changed = rows.filter((r) => r.status === "changed");
    console.log(
      `\n${rows.filter((r) => r.status === "applied").length} applied · ${detected.length} applied but not recorded · ` +
        `${pending.length} pending · ${changed.length} changed · ${unlisted.length} unlisted`
    );
    if (changed.length > 0) {
      console.log(
        "\nNote: 'changed' files were edited after they ran. They are NOT re-run automatically — " +
          "put new changes in a new migration file instead."
      );
    }

    if (!APPLY) {
      if (pending.length + detected.length > 0) console.log('\nRun "npm run db:migrate" to apply.');
      return;
    }

    if (unlisted.length > 0) {
      console.error(
        `\nStopped: ${unlisted.join(", ")} ${unlisted.length === 1 ? "is" : "are"} not in MIGRATIONS ` +
          "(scripts/migrate.ts), so the run order is unknown. Add them there, then run again."
      );
      process.exitCode = 1;
      return;
    }

    // 1) Record migrations that are already in the database.
    for (const { m, sum } of detected) {
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum, method) VALUES ($1, $2, 'detected')
         ON CONFLICT (filename) DO NOTHING`,
        [m.file, sum]
      );
    }
    if (detected.length > 0) console.log(`\nRecorded ${detected.length} already-applied migration(s).`);

    // 2) Run pending ones, in order, stopping at the first failure.
    if (pending.length === 0) {
      console.log("Database is up to date.");
      return;
    }
    for (const { m, sum } of pending) {
      if (m.destructive) {
        const guard = await client.query<{ has_data: boolean }>(m.destructive.guard).catch(() => null);
        if (guard?.rows[0]?.has_data && !ALLOW_DESTRUCTIVE) {
          console.error(
            `\nStopped before ${m.file}: it ${m.destructive.reason}. ` +
              "Back up the database first; to run it anyway, use --allow-destructive."
          );
          process.exitCode = 1;
          return;
        }
      }

      const sql = runnableSql(readFileSync(join(DB_DIR, m.file), "utf8"));
      process.stdout.write(`Applying ${m.file} … `);
      try {
        if (hasOwnTransaction(sql)) {
          // The file commits itself; record it right after.
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (filename, checksum, method) VALUES ($1, $2, 'ran')`,
            [m.file, sum]
          );
        } else {
          // Wrap it so the file and its record commit (or roll back) together.
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (filename, checksum, method) VALUES ($1, $2, 'ran')`,
            [m.file, sum]
          );
          await client.query("COMMIT");
        }
        console.log("done");
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        console.error(`\n${m.file}: ${error instanceof Error ? error.message : String(error)}`);
        console.error("Stopped. Fix the problem and run again — earlier migrations stay applied.");
        process.exitCode = 1;
        return;
      }
    }
    console.log(`\nApplied ${pending.length} migration(s). Database is up to date.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
