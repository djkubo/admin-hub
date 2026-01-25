-- Fix Command Center KPI functions to include all paid statuses
-- and use created_at fallback when stripe_created_at is missing.

CREATE OR REPLACE FUNCTION public.kpi_sales(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(
  currency text,
  total_amount bigint,
  transaction_count bigint,
  avg_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_tz text := 'America/Mexico_City';
BEGIN
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz;
    v_end := (p_end_date || ' 23:59:59')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN
    v_start := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end := v_start + INTERVAL '1 day';
  ELSIF p_range = '7d' THEN
    v_end := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz + INTERVAL '1 day';
    v_start := v_end - INTERVAL '7 days';
  ELSIF p_range = 'month' THEN
    v_start := DATE_TRUNC('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end := v_start + INTERVAL '1 month';
  ELSE
    v_start := '1970-01-01'::timestamptz;
    v_end := NOW() + INTERVAL '1 day';
  END IF;

  RETURN QUERY
  SELECT 
    COALESCE(t.currency, 'usd')::text,
    COALESCE(SUM(t.amount), 0)::bigint,
    COUNT(*)::bigint,
    COALESCE(AVG(t.amount), 0)::numeric
  FROM transactions t
  WHERE t.status IN ('paid', 'succeeded')
    AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
    AND COALESCE(t.stripe_created_at, t.created_at) < v_end
  GROUP BY t.currency;
END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_new_customers(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(
  currency text,
  new_customer_count bigint,
  total_revenue bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_tz text := 'America/Mexico_City';
BEGIN
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz;
    v_end := (p_end_date || ' 23:59:59')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN
    v_start := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end := v_start + INTERVAL '1 day';
  ELSIF p_range = '7d' THEN
    v_end := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz + INTERVAL '1 day';
    v_start := v_end - INTERVAL '7 days';
  ELSIF p_range = 'month' THEN
    v_start := DATE_TRUNC('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end := v_start + INTERVAL '1 month';
  ELSE
    v_start := '1970-01-01'::timestamptz;
    v_end := NOW() + INTERVAL '1 day';
  END IF;

  RETURN QUERY
  WITH first_payments AS (
    SELECT 
      t.stripe_customer_id,
      t.currency,
      MIN(COALESCE(t.stripe_created_at, t.created_at)) as first_payment_date,
      MIN(t.amount) as first_amount
    FROM transactions t
    WHERE t.status IN ('paid', 'succeeded')
      AND t.stripe_customer_id IS NOT NULL
    GROUP BY t.stripe_customer_id, t.currency
    HAVING MIN(COALESCE(t.stripe_created_at, t.created_at)) >= v_start
      AND MIN(COALESCE(t.stripe_created_at, t.created_at)) < v_end
  )
  SELECT 
    COALESCE(fp.currency, 'usd')::text,
    COUNT(DISTINCT fp.stripe_customer_id)::bigint,
    COALESCE(SUM(fp.first_amount), 0)::bigint
  FROM first_payments fp
  GROUP BY fp.currency;
END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_failed_payments(
  p_range text DEFAULT 'today'
)
RETURNS TABLE(
  currency text,
  failed_count bigint,
  at_risk_amount bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_tz text := 'America/Mexico_City';
BEGIN
  IF p_range = 'today' THEN
    v_start := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end := v_start + INTERVAL '1 day';
  ELSIF p_range = '7d' THEN
    v_end := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz + INTERVAL '1 day';
    v_start := v_end - INTERVAL '7 days';
  ELSIF p_range = 'month' THEN
    v_start := DATE_TRUNC('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_end := v_start + INTERVAL '1 month';
  ELSE
    v_start := '1970-01-01'::timestamptz;
    v_end := NOW() + INTERVAL '1 day';
  END IF;

  RETURN QUERY
  SELECT 
    COALESCE(t.currency, 'usd')::text,
    COUNT(*)::bigint,
    COALESCE(SUM(t.amount), 0)::bigint
  FROM transactions t
  WHERE (
      t.status = 'failed'
      OR t.failure_code IN ('requires_payment_method', 'requires_action', 'requires_confirmation')
    )
    AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
    AND COALESCE(t.stripe_created_at, t.created_at) < v_end
  GROUP BY t.currency;
END;
$$;

-- Ensure permissions remain for API role access
GRANT EXECUTE ON FUNCTION public.kpi_sales(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_new_customers(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_failed_payments(text) TO authenticated;
