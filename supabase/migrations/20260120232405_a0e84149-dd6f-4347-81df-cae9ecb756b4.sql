-- Aggressive cleanup: Drop ALL kpi functions using CASCADE
DO $$
DECLARE
  func_rec RECORD;
BEGIN
  FOR func_rec IN 
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname LIKE 'kpi_%'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', func_rec.proname, func_rec.args);
  END LOOP;
END $$;

-- Now create clean versions with standardized timezone
CREATE FUNCTION public.kpi_sales(p_range text DEFAULT 'today', p_start_date text DEFAULT NULL, p_end_date text DEFAULT NULL)
RETURNS TABLE (currency text, total_amount numeric, transaction_count bigint, avg_amount numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz;
    v_end := (p_end_date || ' 23:59:59.999999')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN 
    v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN 
    v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN 
    v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE 
    v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; 
  END IF;
  RETURN QUERY SELECT COALESCE(t.currency, 'usd'), COALESCE(SUM(t.amount), 0), COUNT(*), COALESCE(AVG(t.amount), 0) 
  FROM transactions t WHERE t.status IN ('paid', 'succeeded') AND t.stripe_created_at >= v_start AND t.stripe_created_at < v_end GROUP BY t.currency;
END; $$;

CREATE FUNCTION public.kpi_new_customers(p_range text DEFAULT 'today', p_start_date text DEFAULT NULL, p_end_date text DEFAULT NULL)
RETURNS TABLE (currency text, new_customer_count bigint, total_revenue numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN 
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz; 
    v_end := (p_end_date || ' 23:59:59.999999')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN 
    v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN 
    v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN 
    v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE 
    v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; 
  END IF;
  RETURN QUERY WITH fp AS (
    SELECT t.customer_email, t.currency, MIN(t.stripe_created_at) as first_at, 
    (SELECT t2.amount FROM transactions t2 WHERE t2.customer_email = t.customer_email AND t2.status IN ('paid','succeeded') ORDER BY t2.stripe_created_at LIMIT 1) as amt 
    FROM transactions t WHERE t.status IN ('paid','succeeded') AND t.customer_email IS NOT NULL GROUP BY t.customer_email, t.currency
  ) SELECT COALESCE(fp.currency, 'usd'), COUNT(DISTINCT fp.customer_email), COALESCE(SUM(fp.amt), 0) FROM fp WHERE fp.first_at >= v_start AND fp.first_at < v_end GROUP BY fp.currency;
END; $$;

CREATE FUNCTION public.kpi_renewals(p_range text DEFAULT 'today', p_start_date text DEFAULT NULL, p_end_date text DEFAULT NULL)
RETURNS TABLE (currency text, renewal_count bigint, total_revenue numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN 
    v_start := (p_start_date || ' 00:00:00')::timestamp AT TIME ZONE v_tz; 
    v_end := (p_end_date || ' 23:59:59.999999')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'today' THEN 
    v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN 
    v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN 
    v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE 
    v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; 
    v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; 
  END IF;
  RETURN QUERY WITH fp AS (SELECT customer_email, MIN(stripe_created_at) as first_at FROM transactions WHERE status IN ('paid','succeeded') AND customer_email IS NOT NULL GROUP BY customer_email)
  SELECT COALESCE(t.currency, 'usd'), COUNT(*), COALESCE(SUM(t.amount), 0) FROM transactions t 
  INNER JOIN fp ON t.customer_email = fp.customer_email 
  WHERE t.status IN ('paid','succeeded') AND t.stripe_created_at >= v_start AND t.stripe_created_at < v_end AND t.stripe_created_at > fp.first_at GROUP BY t.currency;
END; $$;

CREATE FUNCTION public.kpi_failed_payments(p_range text DEFAULT 'today')
RETURNS TABLE (currency text, failed_count bigint, at_risk_amount numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_range = 'today' THEN v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; END IF;
  RETURN QUERY SELECT COALESCE(t.currency, 'usd'), COUNT(*), COALESCE(SUM(t.amount), 0) FROM transactions t WHERE t.status = 'failed' AND t.stripe_created_at >= v_start AND t.stripe_created_at < v_end GROUP BY t.currency;
END; $$;

CREATE FUNCTION public.kpi_cancellations(p_range text DEFAULT 'today')
RETURNS TABLE (currency text, cancellation_count bigint, lost_mrr numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_range = 'today' THEN v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; END IF;
  RETURN QUERY SELECT COALESCE(s.currency, 'usd'), COUNT(*), COALESCE(SUM(CASE WHEN s.interval = 'year' THEN s.amount/12 ELSE s.amount END), 0) FROM subscriptions s WHERE s.status = 'canceled' AND s.canceled_at >= v_start AND s.canceled_at < v_end GROUP BY s.currency;
END; $$;

CREATE FUNCTION public.kpi_trial_to_paid(p_range text DEFAULT 'today')
RETURNS TABLE (conversion_count bigint, conversion_rate numeric, total_revenue numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz; v_conv bigint; v_tot bigint; v_rev numeric;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_range = 'today' THEN v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; END IF;
  SELECT COUNT(*), COALESCE(SUM(s.amount),0) INTO v_conv, v_rev FROM subscriptions s WHERE s.trial_start IS NOT NULL AND s.trial_end IS NOT NULL AND s.trial_end >= v_start AND s.trial_end < v_end AND s.status = 'active';
  SELECT COUNT(*) INTO v_tot FROM subscriptions s WHERE s.trial_start IS NOT NULL AND s.trial_end >= v_start AND s.trial_end < v_end;
  RETURN QUERY SELECT COALESCE(v_conv,0), CASE WHEN v_tot > 0 THEN ROUND((v_conv::numeric/v_tot::numeric)*100,2) ELSE 0 END, COALESCE(v_rev,0);
END; $$;

CREATE FUNCTION public.kpi_refunds(p_range text DEFAULT 'today')
RETURNS TABLE (currency text, refund_count bigint, refund_amount numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_start timestamptz; v_end timestamptz; v_now timestamptz;
BEGIN
  v_now := NOW() AT TIME ZONE v_tz;
  IF p_range = 'today' THEN v_start := date_trunc('day', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = '7d' THEN v_start := (date_trunc('day', v_now) - interval '6 days')::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSIF p_range = 'month' THEN v_start := date_trunc('month', v_now)::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz;
  ELSE v_start := '2020-01-01'::timestamp AT TIME ZONE v_tz; v_end := (date_trunc('day', v_now) + interval '1 day')::timestamp AT TIME ZONE v_tz; END IF;
  RETURN QUERY SELECT COALESCE(t.currency, 'usd'), COUNT(*), COALESCE(SUM(ABS(t.amount)), 0) FROM transactions t WHERE t.status = 'refunded' AND t.stripe_created_at >= v_start AND t.stripe_created_at < v_end GROUP BY t.currency;
END; $$;

CREATE FUNCTION public.kpi_mrr()
RETURNS TABLE (currency text, mrr numeric, active_subscriptions bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY SELECT COALESCE(s.currency, 'usd'), COALESCE(SUM(CASE WHEN s.interval = 'year' THEN s.amount/12 ELSE s.amount END), 0), COUNT(*) 
  FROM subscriptions s WHERE s.status = 'active' GROUP BY s.currency;
END; $$;

CREATE FUNCTION public.kpi_churn_30d()
RETURNS TABLE (churned_count bigint, active_count bigint, churn_rate numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text := 'America/Mexico_City'; v_30d_ago timestamptz; v_churned bigint; v_active bigint;
BEGIN
  v_30d_ago := (NOW() AT TIME ZONE v_tz - interval '30 days');
  SELECT COUNT(*) INTO v_churned FROM subscriptions WHERE status = 'canceled' AND canceled_at >= v_30d_ago;
  SELECT COUNT(*) INTO v_active FROM subscriptions WHERE status = 'active';
  RETURN QUERY SELECT COALESCE(v_churned,0), COALESCE(v_active,0), CASE WHEN (v_active + v_churned) > 0 THEN ROUND((v_churned::numeric/(v_active + v_churned)::numeric)*100, 2) ELSE 0 END;
END; $$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.kpi_sales TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_new_customers TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_renewals TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_failed_payments TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_cancellations TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_trial_to_paid TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_refunds TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_mrr TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_churn_30d TO authenticated;