-- partitions_v2.sql
--
-- Extends the monthly partitions of every partitioned table and adds a
-- DEFAULT partition to each as a safety net.
--
-- Why: schema.sql only created credit_ledger partitions for 2026-09 and
-- 2026-10, and usage_events/messages were extended only to 2027-03. An insert
-- with no matching partition fails outright — for credit_ledger that means
-- every debit, purchase and grant fails once the month rolls over (after the
-- provider has already been paid for the request).
--
-- DEFAULT partitions catch any row whose month has no partition yet, so a
-- missed extension degrades to "rows in the default partition" instead of an
-- outage. Caveat: creating a monthly partition later fails if the default
-- already holds rows for that month — keep extending ahead of time (re-run
-- this file with a later end_month) rather than relying on the default.
--
-- Safe to re-run: skips partitions that already exist.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/partitions_v2.sql
-- =========================================================================

DO $$
DECLARE
  tbl         text;
  start_month date := DATE '2026-11-01';
  end_month   date := DATE '2028-01-01';  -- exclusive: creates through 2027-12
  d           date;
  part_name   text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['credit_ledger', 'usage_events', 'messages'] LOOP
    d := start_month;
    WHILE d < end_month LOOP
      part_name := tbl || '_' || to_char(d, 'YYYY_MM');
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = part_name AND n.nspname = 'public'
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          part_name,
          tbl,
          to_char(d, 'YYYY-MM-DD'),
          to_char(d + interval '1 month', 'YYYY-MM-DD')
        );
      END IF;
      d := (d + interval '1 month')::date;
    END LOOP;

    part_name := tbl || '_default';
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = part_name AND n.nspname = 'public'
    ) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', part_name, tbl);
    END IF;
  END LOOP;
END $$;
