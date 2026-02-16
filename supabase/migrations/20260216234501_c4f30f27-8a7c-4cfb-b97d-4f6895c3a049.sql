-- Fix timeout issues on kpi_new_customers and kpi_renewals
-- These scan 100k+ transactions and hit the default 8s PostgREST timeout

-- 1) kpi_new_customers: use MIN() aggregation instead of DISTINCT ON
DROP FUNCTION IF EXISTS public.kpi_new_customers(text, text, text);

CREATE OR REPLACE FUNCTION public.kpi_new_customers(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(currency text, new_customer_count bigint, total_revenue bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
  v_tz    text := 'America/Mexico_City';
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz;
    v_end   := (p_end_date   || ' 23:59:59')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN
    v_start := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end   := v_start + INTERVAL '1 day';
  ELSIF p_range = '7d' THEN
    v_end   := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz + INTERVAL '1 day';
    v_start := v_end - INTERVAL '7 days';
  ELSIF p_range = 'month' THEN
    v_start := DATE_TRUNC('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end   := v_start + INTERVAL '1 month';
  ELSE
    v_start := '1970-01-01'::timestamptz;
    v_end   := NOW() + INTERVAL '1 day';
  END IF;

  RETURN QUERY
  WITH first_pay AS (
    SELECT LOWER(t.customer_email) AS em,
           COALESCE(t.currency,'usd') AS cur,
           MIN(t.stripe_created_at) AS first_dt
    FROM transactions t
    WHERE t.status IN ('paid','succeeded')
      AND t.customer_email IS NOT NULL
      AND t.stripe_created_at IS NOT NULL
    GROUP BY LOWER(t.customer_email), COALESCE(t.currency,'usd')
  )
  SELECT fp.cur::text AS currency,
         COUNT(*)::bigint AS new_customer_count,
         0::bigint AS total_revenue
  FROM first_pay fp
  WHERE fp.first_dt >= v_start AND fp.first_dt < v_end
  GROUP BY fp.cur;
END;
$$;

-- 2) kpi_renewals: same optimization
DROP FUNCTION IF EXISTS public.kpi_renewals(text, text, text);

CREATE OR REPLACE FUNCTION public.kpi_renewals(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(currency text, renewal_count bigint, total_revenue bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
  v_tz    text := 'America/Mexico_City';
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz;
    v_end   := (p_end_date   || ' 23:59:59')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN
    v_start := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end   := v_start + INTERVAL '1 day';
  ELSIF p_range = '7d' THEN
    v_end   := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz + INTERVAL '1 day';
    v_start := v_end - INTERVAL '7 days';
  ELSIF p_range = 'month' THEN
    v_start := DATE_TRUNC('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end   := v_start + INTERVAL '1 month';
  ELSE
    v_start := '1970-01-01'::timestamptz;
    v_end   := NOW() + INTERVAL '1 day';
  END IF;

  RETURN QUERY
  WITH first_pay AS (
    SELECT LOWER(t.customer_email) AS em,
           MIN(t.stripe_created_at) AS first_dt
    FROM transactions t
    WHERE t.status IN ('paid','succeeded')
      AND t.customer_email IS NOT NULL
      AND t.stripe_created_at IS NOT NULL
    GROUP BY LOWER(t.customer_email)
  ),
  ren AS (
    SELECT COALESCE(t.currency,'usd') AS cur,
           t.amount
    FROM transactions t
    JOIN first_pay fp ON LOWER(t.customer_email) = fp.em
    WHERE t.status IN ('paid','succeeded')
      AND t.stripe_created_at >= v_start
      AND t.stripe_created_at < v_end
      AND t.stripe_created_at > fp.first_dt
  )
  SELECT r.cur::text AS currency,
         COUNT(*)::bigint AS renewal_count,
         COALESCE(SUM(r.amount),0)::bigint AS total_revenue
  FROM ren r
  GROUP BY r.cur;
END;
$$;

-- Grants
REVOKE EXECUTE ON FUNCTION public.kpi_new_customers(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kpi_new_customers(text,text,text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.kpi_renewals(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kpi_renewals(text,text,text) TO authenticated, service_role;

-- Add index to speed up these queries if not exists
CREATE INDEX IF NOT EXISTS idx_transactions_email_status_created
ON transactions (status, customer_email, stripe_created_at)
WHERE status IN ('paid','succeeded') AND customer_email IS NOT NULL;