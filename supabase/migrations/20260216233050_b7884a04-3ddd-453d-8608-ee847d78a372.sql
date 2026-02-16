
-- ============================================================
-- FIX: Drop ALL overloads of conflicting functions
-- ============================================================

DROP FUNCTION IF EXISTS public.kpi_failed_payments();
DROP FUNCTION IF EXISTS public.kpi_failed_payments(text);
DROP FUNCTION IF EXISTS public.kpi_failed_payments(text, text, text);
DROP FUNCTION IF EXISTS public.kpi_failed_payments(int);
DROP FUNCTION IF EXISTS public.kpi_failed_payments(integer);

CREATE OR REPLACE FUNCTION public.kpi_failed_payments()
RETURNS TABLE(
  total_amount bigint,
  fail_count bigint,
  top_reasons jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT
    COALESCE(SUM(t.amount), 0)::bigint AS total_amount,
    COUNT(*)::bigint AS fail_count,
    COALESCE(
      (SELECT jsonb_agg(row_to_json(r)) FROM (
        SELECT t2.failure_message AS reason, COUNT(*)::bigint AS cnt
        FROM transactions t2
        WHERE t2.status IN ('failed', 'requires_action', 'requires_payment_method')
          AND t2.stripe_created_at >= NOW() - INTERVAL '30 days'
          AND t2.failure_message IS NOT NULL
        GROUP BY t2.failure_message
        ORDER BY cnt DESC
        LIMIT 5
      ) r),
      '[]'::jsonb
    ) AS top_reasons
  FROM transactions t
  WHERE t.status IN ('failed', 'requires_action', 'requires_payment_method')
    AND t.stripe_created_at >= NOW() - INTERVAL '30 days';
END;
$$;

-- kpi_new_customers
DROP FUNCTION IF EXISTS public.kpi_new_customers();
DROP FUNCTION IF EXISTS public.kpi_new_customers(text);
DROP FUNCTION IF EXISTS public.kpi_new_customers(text, text, text);

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
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
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
    SELECT DISTINCT ON (LOWER(t.customer_email), COALESCE(t.currency, 'usd'))
      LOWER(t.customer_email) AS customer_email,
      COALESCE(t.currency, 'usd')::text AS currency,
      t.stripe_created_at AS first_payment_date,
      t.amount AS first_amount
    FROM transactions t
    WHERE t.status IN ('paid', 'succeeded')
      AND t.customer_email IS NOT NULL
      AND t.stripe_created_at IS NOT NULL
    ORDER BY LOWER(t.customer_email), COALESCE(t.currency, 'usd'), t.stripe_created_at ASC
  )
  SELECT
    fp.currency,
    COUNT(*)::bigint AS new_customer_count,
    COALESCE(SUM(fp.first_amount), 0)::bigint AS total_revenue
  FROM first_payments fp
  WHERE fp.first_payment_date >= v_start
    AND fp.first_payment_date < v_end
  GROUP BY fp.currency;
END;
$$;

-- kpi_renewals
DROP FUNCTION IF EXISTS public.kpi_renewals();
DROP FUNCTION IF EXISTS public.kpi_renewals(text);
DROP FUNCTION IF EXISTS public.kpi_renewals(text, text, text);

CREATE OR REPLACE FUNCTION public.kpi_renewals(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(
  currency text,
  renewal_count bigint,
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
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
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
      LOWER(t.customer_email) AS customer_email,
      MIN(t.stripe_created_at) AS first_date
    FROM transactions t
    WHERE t.status IN ('paid', 'succeeded')
      AND t.customer_email IS NOT NULL
      AND t.stripe_created_at IS NOT NULL
    GROUP BY LOWER(t.customer_email)
  ),
  renewals AS (
    SELECT
      COALESCE(t.currency, 'usd')::text AS currency,
      t.amount
    FROM transactions t
    INNER JOIN first_payments fp ON LOWER(t.customer_email) = fp.customer_email
    WHERE t.status IN ('paid', 'succeeded')
      AND t.stripe_created_at >= v_start
      AND t.stripe_created_at < v_end
      AND t.stripe_created_at > fp.first_date
  )
  SELECT
    r.currency,
    COUNT(*)::bigint AS renewal_count,
    COALESCE(SUM(r.amount), 0)::bigint AS total_revenue
  FROM renewals r
  GROUP BY r.currency;
END;
$$;

-- rebuild_metrics_staging
DROP FUNCTION IF EXISTS public.rebuild_metrics_staging();

CREATE OR REPLACE FUNCTION public.rebuild_metrics_staging()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_kpis jsonb;
  v_sales_today jsonb;
  v_sales_month jsonb;
  v_mrr jsonb;
  v_churn jsonb;
  v_new_customers jsonb;
  v_failed jsonb;
  v_rebuild_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  INSERT INTO rebuild_logs (status, created_by)
  VALUES ('running', current_user)
  RETURNING id INTO v_rebuild_id;

  SELECT jsonb_agg(row_to_json(s)) INTO v_sales_today FROM kpi_sales('today') s;
  SELECT jsonb_agg(row_to_json(s)) INTO v_sales_month FROM kpi_sales('month') s;

  BEGIN
    SELECT jsonb_agg(row_to_json(m)) INTO v_mrr FROM kpi_mrr() m;
  EXCEPTION WHEN undefined_function THEN
    v_mrr := '[]'::jsonb;
  END;

  BEGIN
    SELECT jsonb_agg(row_to_json(c)) INTO v_churn FROM kpi_churn_30d() c;
  EXCEPTION WHEN undefined_function THEN
    v_churn := '[]'::jsonb;
  END;

  SELECT jsonb_agg(row_to_json(n)) INTO v_new_customers FROM kpi_new_customers() n;
  SELECT row_to_json(f)::jsonb INTO v_failed FROM kpi_failed_payments() f;

  v_kpis := jsonb_build_object(
    'sales_today', COALESCE(v_sales_today, '[]'::jsonb),
    'sales_month', COALESCE(v_sales_month, '[]'::jsonb),
    'mrr', COALESCE(v_mrr, '[]'::jsonb),
    'churn_30d', COALESCE(v_churn, '[]'::jsonb),
    'new_customers_month', COALESCE(v_new_customers, '[]'::jsonb),
    'failed_payments_30d', COALESCE(v_failed, '{}'::jsonb),
    'generated_at', now()
  );

  INSERT INTO metrics_snapshots (snapshot_type, kpis)
  VALUES ('staging', v_kpis);

  UPDATE rebuild_logs SET
    status = 'completed',
    completed_at = now(),
    rows_processed = (
      SELECT COUNT(*) FROM transactions WHERE status IN ('succeeded', 'paid')
    )
  WHERE id = v_rebuild_id;

  RETURN v_kpis;
EXCEPTION WHEN OTHERS THEN
  UPDATE rebuild_logs SET
    status = 'error',
    completed_at = now(),
    errors = jsonb_build_object('message', SQLERRM, 'state', SQLSTATE)
  WHERE id = v_rebuild_id;
  RETURN jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$;

-- Grant permissions
REVOKE EXECUTE ON FUNCTION public.kpi_failed_payments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kpi_failed_payments() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.kpi_new_customers(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kpi_new_customers(text, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.kpi_renewals(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kpi_renewals(text, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.rebuild_metrics_staging() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_metrics_staging() TO authenticated, service_role;
