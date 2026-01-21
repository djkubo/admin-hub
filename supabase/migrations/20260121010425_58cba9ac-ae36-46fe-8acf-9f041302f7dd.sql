
-- Fix KPI functions - type mismatch issue (bigint vs numeric)
-- Drop and recreate with correct types

-- Drop all existing kpi functions
DROP FUNCTION IF EXISTS public.kpi_sales(text, text, text);
DROP FUNCTION IF EXISTS public.kpi_new_customers(text, text, text);
DROP FUNCTION IF EXISTS public.kpi_renewals(text, text, text);
DROP FUNCTION IF EXISTS public.kpi_failed_payments(text);
DROP FUNCTION IF EXISTS public.kpi_cancellations(text);
DROP FUNCTION IF EXISTS public.kpi_trial_to_paid(text);
DROP FUNCTION IF EXISTS public.kpi_refunds(text);
DROP FUNCTION IF EXISTS public.kpi_mrr();
DROP FUNCTION IF EXISTS public.kpi_churn_30d();

-- Recreate kpi_sales with correct types (use bigint for SUM of integers)
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
  WHERE t.status = 'paid'
    AND t.stripe_created_at >= v_start 
    AND t.stripe_created_at < v_end
  GROUP BY t.currency;
END;
$$;

-- Recreate kpi_new_customers with correct types
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
      MIN(t.stripe_created_at) as first_payment_date,
      MIN(t.amount) as first_amount
    FROM transactions t
    WHERE t.status = 'paid'
      AND t.stripe_customer_id IS NOT NULL
    GROUP BY t.stripe_customer_id, t.currency
    HAVING MIN(t.stripe_created_at) >= v_start AND MIN(t.stripe_created_at) < v_end
  )
  SELECT 
    COALESCE(fp.currency, 'usd')::text,
    COUNT(DISTINCT fp.stripe_customer_id)::bigint,
    COALESCE(SUM(fp.first_amount), 0)::bigint
  FROM first_payments fp
  GROUP BY fp.currency;
END;
$$;

-- Recreate kpi_renewals with correct types
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
    SELECT t.stripe_customer_id, MIN(t.stripe_created_at) as first_date
    FROM transactions t
    WHERE t.status = 'paid' AND t.stripe_customer_id IS NOT NULL
    GROUP BY t.stripe_customer_id
  ),
  renewals AS (
    SELECT t.id, t.currency, t.amount
    FROM transactions t
    INNER JOIN first_payments fp ON t.stripe_customer_id = fp.stripe_customer_id
    WHERE t.status = 'paid'
      AND t.stripe_created_at >= v_start 
      AND t.stripe_created_at < v_end
      AND t.stripe_created_at > fp.first_date
  )
  SELECT 
    COALESCE(r.currency, 'usd')::text,
    COUNT(*)::bigint,
    COALESCE(SUM(r.amount), 0)::bigint
  FROM renewals r
  GROUP BY r.currency;
END;
$$;

-- Recreate kpi_failed_payments with correct types
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
  WHERE t.status = 'failed'
    AND t.stripe_created_at >= v_start 
    AND t.stripe_created_at < v_end
  GROUP BY t.currency;
END;
$$;

-- Recreate kpi_cancellations with correct types
CREATE OR REPLACE FUNCTION public.kpi_cancellations(
  p_range text DEFAULT 'today'
)
RETURNS TABLE(
  currency text,
  cancellation_count bigint,
  lost_mrr bigint
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
    COALESCE(s.currency, 'usd')::text,
    COUNT(*)::bigint,
    COALESCE(SUM(s.amount), 0)::bigint
  FROM subscriptions s
  WHERE s.status = 'canceled'
    AND s.canceled_at >= v_start 
    AND s.canceled_at < v_end
  GROUP BY s.currency;
END;
$$;

-- Recreate kpi_trial_to_paid with correct types
CREATE OR REPLACE FUNCTION public.kpi_trial_to_paid(
  p_range text DEFAULT 'today'
)
RETURNS TABLE(
  conversion_count bigint,
  conversion_rate numeric,
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
  v_total_trials bigint;
  v_conversions bigint;
  v_revenue bigint;
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

  -- Count trials that converted to paid in period
  SELECT COUNT(*), COALESCE(SUM(s.amount), 0)
  INTO v_conversions, v_revenue
  FROM subscriptions s
  WHERE s.trial_end IS NOT NULL
    AND s.status IN ('active', 'paid')
    AND s.trial_end >= v_start
    AND s.trial_end < v_end;

  -- Count total trials in the period
  SELECT COUNT(*) INTO v_total_trials
  FROM subscriptions s
  WHERE s.trial_start >= v_start AND s.trial_start < v_end;

  RETURN QUERY
  SELECT 
    COALESCE(v_conversions, 0)::bigint,
    CASE WHEN v_total_trials > 0 THEN (v_conversions::numeric / v_total_trials * 100) ELSE 0 END,
    COALESCE(v_revenue, 0)::bigint;
END;
$$;

-- Recreate kpi_refunds with correct types
CREATE OR REPLACE FUNCTION public.kpi_refunds(
  p_range text DEFAULT 'today'
)
RETURNS TABLE(
  currency text,
  refund_count bigint,
  refund_amount bigint
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
    COALESCE(SUM(ABS(t.amount)), 0)::bigint
  FROM transactions t
  WHERE t.status = 'refunded'
    AND t.stripe_created_at >= v_start 
    AND t.stripe_created_at < v_end
  GROUP BY t.currency;
END;
$$;

-- Recreate kpi_mrr with correct types
CREATE OR REPLACE FUNCTION public.kpi_mrr()
RETURNS TABLE(
  currency text,
  mrr bigint,
  active_subscriptions bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(s.currency, 'usd')::text,
    COALESCE(SUM(
      CASE 
        WHEN s.interval = 'year' THEN s.amount / 12
        WHEN s.interval = 'week' THEN s.amount * 4
        ELSE s.amount
      END
    ), 0)::bigint,
    COUNT(*)::bigint
  FROM subscriptions s
  WHERE s.status IN ('active', 'trialing')
  GROUP BY s.currency;
END;
$$;

-- Recreate kpi_churn_30d with correct types
CREATE OR REPLACE FUNCTION public.kpi_churn_30d()
RETURNS TABLE(
  churned_count bigint,
  active_count bigint,
  churn_rate numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_churned bigint;
  v_active bigint;
  v_tz text := 'America/Mexico_City';
BEGIN
  SELECT COUNT(*) INTO v_churned
  FROM subscriptions s
  WHERE s.status = 'canceled'
    AND s.canceled_at >= (NOW() AT TIME ZONE v_tz - INTERVAL '30 days');

  SELECT COUNT(*) INTO v_active
  FROM subscriptions s
  WHERE s.status IN ('active', 'trialing');

  RETURN QUERY
  SELECT 
    COALESCE(v_churned, 0)::bigint,
    COALESCE(v_active, 0)::bigint,
    CASE WHEN (v_active + v_churned) > 0 
      THEN (v_churned::numeric / (v_active + v_churned) * 100) 
      ELSE 0 
    END;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.kpi_sales(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_new_customers(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_renewals(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_failed_payments(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_cancellations(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_trial_to_paid(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_refunds(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_mrr() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_churn_30d() TO authenticated;
