-- Make get_staging_counts_accurate resilient to statement timeouts on large raw tables.
-- Keeps exact counts when possible and falls back to planner estimates on timeout.

CREATE OR REPLACE FUNCTION public.get_staging_counts_accurate()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '20s'
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ghl_total bigint := 0;
  v_ghl_unprocessed bigint := 0;
  v_manychat_total bigint := 0;
  v_manychat_unprocessed bigint := 0;
  v_csv_total bigint := 0;
  v_csv_staged bigint := 0;
  v_clients_total bigint := 0;
  v_transactions_total bigint := 0;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  BEGIN
    SELECT COUNT(*) INTO v_ghl_total FROM public.ghl_contacts_raw;
  EXCEPTION
    WHEN query_canceled THEN
      SELECT COALESCE((
        SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
        FROM pg_class
        WHERE oid = 'ghl_contacts_raw'::regclass
      ), 0)::bigint
      INTO v_ghl_total;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_ghl_unprocessed
    FROM public.ghl_contacts_raw
    WHERE processed_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN
      SELECT COALESCE((
        SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
        FROM pg_class
        WHERE oid = 'idx_ghl_raw_unprocessed'::regclass
      ), 0)::bigint
      INTO v_ghl_unprocessed;
      IF v_ghl_unprocessed <= 0 THEN
        v_ghl_unprocessed := v_ghl_total;
      END IF;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_manychat_total FROM public.manychat_contacts_raw;
  EXCEPTION
    WHEN query_canceled THEN
      SELECT COALESCE((
        SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
        FROM pg_class
        WHERE oid = 'manychat_contacts_raw'::regclass
      ), 0)::bigint
      INTO v_manychat_total;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_manychat_unprocessed
    FROM public.manychat_contacts_raw
    WHERE processed_at IS NULL;
  EXCEPTION
    WHEN query_canceled THEN
      SELECT COALESCE((
        SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
        FROM pg_class
        WHERE oid = 'idx_manychat_raw_unprocessed'::regclass
      ), 0)::bigint
      INTO v_manychat_unprocessed;
      IF v_manychat_unprocessed <= 0 THEN
        v_manychat_unprocessed := v_manychat_total;
      END IF;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_csv_total FROM public.csv_imports_raw;
  EXCEPTION
    WHEN query_canceled THEN
      SELECT COALESCE((
        SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
        FROM pg_class
        WHERE oid = 'csv_imports_raw'::regclass
      ), 0)::bigint
      INTO v_csv_total;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_csv_staged
    FROM public.csv_imports_raw
    WHERE processing_status IN ('staged', 'pending');
  EXCEPTION
    WHEN query_canceled THEN
      SELECT COALESCE((
        SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
        FROM pg_class
        WHERE oid = 'idx_csv_raw_staged'::regclass
      ), 0)::bigint
      INTO v_csv_staged;
      IF v_csv_staged <= 0 THEN
        v_csv_staged := v_csv_total;
      END IF;
  END;

  SELECT COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'clients'), 0)::bigint
  INTO v_clients_total;
  SELECT COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'transactions'), 0)::bigint
  INTO v_transactions_total;

  RETURN json_build_object(
    'ghl_total', COALESCE(v_ghl_total, 0),
    'ghl_unprocessed', COALESCE(v_ghl_unprocessed, 0),
    'manychat_total', COALESCE(v_manychat_total, 0),
    'manychat_unprocessed', COALESCE(v_manychat_unprocessed, 0),
    'csv_total', COALESCE(v_csv_total, 0),
    'csv_staged', COALESCE(v_csv_staged, 0),
    'clients_total', COALESCE(v_clients_total, 0),
    'transactions_total', COALESCE(v_transactions_total, 0)
  );
END;
$function$;

-- Partial indexes used by staging counters to keep pending queries O(1) on partitions.
CREATE INDEX IF NOT EXISTS idx_ghl_raw_unprocessed
ON public.ghl_contacts_raw (id)
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_manychat_raw_unprocessed
ON public.manychat_contacts_raw (id)
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_csv_raw_staged
ON public.csv_imports_raw (id)
WHERE processing_status IN ('staged', 'pending');

CREATE OR REPLACE FUNCTION public.get_staging_counts_fast()
RETURNS json
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT json_build_object(
    'ghl_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'ghl_contacts_raw'), 0),
    'ghl_unprocessed', COALESCE((
      (SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
      FROM pg_class WHERE oid = 'idx_ghl_raw_unprocessed'::regclass)
    )::bigint, (
      SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'ghl_contacts_raw'
    ), 0),
    'manychat_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'manychat_contacts_raw'), 0),
    'manychat_unprocessed', COALESCE((
      (SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
      FROM pg_class WHERE oid = 'idx_manychat_raw_unprocessed'::regclass)
    )::bigint, (
      SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'manychat_contacts_raw'
    ), 0),
    'csv_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'csv_imports_raw'), 0),
    'csv_staged', COALESCE((
      (SELECT CASE WHEN reltuples > 0 THEN reltuples ELSE NULL END
      FROM pg_class WHERE oid = 'idx_csv_raw_staged'::regclass)
    )::bigint, (
      SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'csv_imports_raw'
    ), 0),
    'clients_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'clients'), 0),
    'transactions_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'transactions'), 0)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.get_staging_counts_fast() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_staging_counts_fast() TO authenticated, service_role;
