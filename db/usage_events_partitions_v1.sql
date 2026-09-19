-- usage_events_partitions_v1.sql
--
-- Ensure monthly partitions exist for usage_events inserts.
-- schema.sql only creates 2026-09 and 2026-10; extend forward like messages.
-- Safe to re-run: skips partitions that already exist.

DO $$
DECLARE
  start_month date := DATE '2026-11-01';
  end_month   date := DATE '2027-04-01';
  d           date;
  part_name   text;
  from_ts     text;
  to_ts       text;
BEGIN
  d := start_month;
  WHILE d < end_month LOOP
    part_name := 'usage_events_' || to_char(d, 'YYYY_MM');
    from_ts := to_char(d, 'YYYY-MM-DD');
    to_ts := to_char(d + interval '1 month', 'YYYY-MM-DD');

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = part_name AND n.nspname = 'public'
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
        part_name,
        from_ts,
        to_ts
      );
    END IF;

    d := (d + interval '1 month')::date;
  END LOOP;
END $$;
