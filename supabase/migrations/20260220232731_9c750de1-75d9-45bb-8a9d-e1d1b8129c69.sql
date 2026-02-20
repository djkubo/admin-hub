-- Fix data_quality_checks RPC:
-- - remove invalid reference to transactions.client_id (column does not exist)
-- - keep response shape compatible with frontend (status/count)

DROP FUNCTION IF EXISTS public.data_quality_checks();

CREATE OR REPLACE FUNCTION public.data_quality_checks()
RETURNS TABLE(
  check_name text,
  status text,
  count bigint,
  percentage numeric,
  details jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout TO '10s'
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY

  -- Check 1: Duplicate emails
  SELECT
    'duplicate_emails'::text,
    CASE WHEN COUNT(*) > 0 THEN 'warning' ELSE 'ok' END::text,
    COUNT(*)::bigint,
    0::numeric,
    COALESCE(
      (
        SELECT jsonb_agg(jsonb_build_object('email', e, 'count', c))
        FROM (
          SELECT lower(trim(c2.email)) as e, count(*) as c
          FROM clients c2
          WHERE c2.email IS NOT NULL AND trim(c2.email) <> ''
          GROUP BY lower(trim(c2.email))
          HAVING count(*) > 1
          LIMIT 20
        ) dupes
      ),
      '[]'::jsonb
    )
  FROM (
    SELECT lower(trim(c3.email)) as e
    FROM clients c3
    WHERE c3.email IS NOT NULL AND trim(c3.email) <> ''
    GROUP BY lower(trim(c3.email))
    HAVING count(*) > 1
  ) d

  UNION ALL

  -- Check 2: Clients without email
  SELECT
    'clients_without_email'::text,
    CASE WHEN COUNT(*) > 100 THEN 'warning' ELSE 'info' END::text,
    COUNT(*)::bigint,
    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM clients), 0), 2)::numeric,
    jsonb_build_object('total_clients', (SELECT COUNT(*) FROM clients))
  FROM clients
  WHERE email IS NULL OR trim(email) = ''

  UNION ALL

  -- Check 3: Recent transactions that cannot be mapped to any client
  SELECT
    'orphan_transactions'::text,
    CASE WHEN COUNT(*) > 50 THEN 'warning' ELSE 'info' END::text,
    COUNT(*)::bigint,
    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM transactions WHERE stripe_created_at >= NOW() - INTERVAL '30 days'), 0), 2)::numeric,
    jsonb_build_object('total_transactions_30d', (SELECT COUNT(*) FROM transactions WHERE stripe_created_at >= NOW() - INTERVAL '30 days'))
  FROM transactions t
  WHERE t.stripe_created_at >= NOW() - INTERVAL '30 days'
    AND NOT EXISTS (
      SELECT 1
      FROM clients c5
      WHERE (
        t.stripe_customer_id IS NOT NULL
        AND c5.stripe_customer_id = t.stripe_customer_id
      )
      OR (
        t.customer_email IS NOT NULL
        AND trim(t.customer_email) <> ''
        AND c5.email IS NOT NULL
        AND lower(trim(c5.email)) = lower(trim(t.customer_email))
      )
    )

  UNION ALL

  -- Check 4: Stale sync runs
  SELECT
    'stale_sync_runs'::text,
    CASE WHEN COUNT(*) > 0 THEN 'warning' ELSE 'ok' END::text,
    COUNT(*)::bigint,
    0::numeric,
    '[]'::jsonb
  FROM sync_runs
  WHERE status = 'running'
    AND started_at < NOW() - INTERVAL '2 hours'

  UNION ALL

  -- Check 5: Mixed currencies in recent transactions
  SELECT
    'mixed_currencies'::text,
    CASE WHEN COUNT(DISTINCT t2.currency) > 1 THEN 'info' ELSE 'ok' END::text,
    COUNT(DISTINCT t2.currency)::bigint,
    0::numeric,
    COALESCE(jsonb_agg(DISTINCT t2.currency), '[]'::jsonb)
  FROM transactions t2
  WHERE t2.created_at >= NOW() - INTERVAL '30 days'
    AND t2.status IN ('succeeded', 'paid')

  UNION ALL

  -- Check 6: Clients without attribution source
  SELECT
    'clients_without_source'::text,
    CASE WHEN COUNT(*) FILTER (WHERE c4.acquisition_source IS NULL) * 100.0 / NULLIF(COUNT(*), 0) > 30
      THEN 'warning' ELSE 'info' END::text,
    COUNT(*) FILTER (WHERE c4.acquisition_source IS NULL)::bigint,
    ROUND(COUNT(*) FILTER (WHERE c4.acquisition_source IS NULL) * 100.0 / NULLIF(COUNT(*), 0), 2)::numeric,
    jsonb_build_object('total', COUNT(*))
  FROM clients c4;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.data_quality_checks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.data_quality_checks() TO authenticated, service_role;