-- Fix kpi_sales to include 'paid' status (from PayPal/Stripe mapping)
CREATE OR REPLACE FUNCTION public.kpi_sales(p_range text DEFAULT 'today'::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS TABLE(currency text, total_amount bigint, transaction_count bigint, avg_amount bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text := get_system_timezone();
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  -- Calculate date range based on timezone
  CASE p_range
    WHEN 'today' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 day';
    WHEN '7d' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz - INTERVAL '7 days') AT TIME ZONE v_tz;
      v_end := NOW();
    WHEN '30d' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz - INTERVAL '30 days') AT TIME ZONE v_tz;
      v_end := NOW();
    WHEN 'month' THEN
      v_start := date_trunc('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 month';
    WHEN 'year' THEN
      v_start := date_trunc('year', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 year';
    WHEN 'custom' THEN
      v_start := p_start_date::timestamptz;
      v_end := (p_end_date + 1)::timestamptz;
    ELSE
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := NOW();
  END CASE;

  RETURN QUERY
  SELECT 
    COALESCE(t.currency, 'usd') as currency,
    COALESCE(SUM(t.amount), 0)::bigint as total_amount,
    COUNT(*)::bigint as transaction_count,
    COALESCE(AVG(t.amount), 0)::bigint as avg_amount
  FROM transactions t
  WHERE t.status IN ('succeeded', 'paid')  -- Include both status values
    AND t.amount > 0
    AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
    AND COALESCE(t.stripe_created_at, t.created_at) < v_end
  GROUP BY COALESCE(t.currency, 'usd');
END;
$function$;

-- Fix kpi_new_customers to include 'paid' status
CREATE OR REPLACE FUNCTION public.kpi_new_customers(p_range text DEFAULT 'today'::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS TABLE(new_customer_count bigint, total_revenue bigint, currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text := get_system_timezone();
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  CASE p_range
    WHEN 'today' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 day';
    WHEN '7d' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz - INTERVAL '7 days') AT TIME ZONE v_tz;
      v_end := NOW();
    WHEN '30d' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz - INTERVAL '30 days') AT TIME ZONE v_tz;
      v_end := NOW();
    WHEN 'month' THEN
      v_start := date_trunc('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 month';
    ELSE
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := NOW();
  END CASE;

  RETURN QUERY
  WITH first_payments AS (
    SELECT 
      t.customer_email,
      MIN(COALESCE(t.stripe_created_at, t.created_at)) as first_payment_at,
      t.currency
    FROM transactions t
    WHERE t.status IN ('succeeded', 'paid')  -- Include both
      AND t.amount > 0 
      AND t.customer_email IS NOT NULL
    GROUP BY t.customer_email, t.currency
    HAVING MIN(COALESCE(t.stripe_created_at, t.created_at)) >= v_start
       AND MIN(COALESCE(t.stripe_created_at, t.created_at)) < v_end
  )
  SELECT 
    COUNT(DISTINCT fp.customer_email)::bigint as new_customer_count,
    COALESCE(SUM(t.amount), 0)::bigint as total_revenue,
    COALESCE(fp.currency, 'usd') as currency
  FROM first_payments fp
  JOIN transactions t ON t.customer_email = fp.customer_email 
    AND COALESCE(t.stripe_created_at, t.created_at) = fp.first_payment_at
    AND t.status IN ('succeeded', 'paid')
  GROUP BY fp.currency;
END;
$function$;

-- Fix kpi_renewals to include 'paid' status
CREATE OR REPLACE FUNCTION public.kpi_renewals(p_range text DEFAULT 'today'::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS TABLE(renewal_count bigint, total_revenue bigint, currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text := get_system_timezone();
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  CASE p_range
    WHEN 'today' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 day';
    WHEN '7d' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz - INTERVAL '7 days') AT TIME ZONE v_tz;
      v_end := NOW();
    WHEN '30d' THEN
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz - INTERVAL '30 days') AT TIME ZONE v_tz;
      v_end := NOW();
    WHEN 'month' THEN
      v_start := date_trunc('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := v_start + INTERVAL '1 month';
    ELSE
      v_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
      v_end := NOW();
  END CASE;

  RETURN QUERY
  SELECT 
    COUNT(*)::bigint as renewal_count,
    COALESCE(SUM(t.amount), 0)::bigint as total_revenue,
    COALESCE(t.currency, 'usd') as currency
  FROM transactions t
  WHERE t.status IN ('succeeded', 'paid')  -- Include both
    AND t.amount > 0
    AND t.payment_type = 'renewal'
    AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
    AND COALESCE(t.stripe_created_at, t.created_at) < v_end
  GROUP BY COALESCE(t.currency, 'usd');
END;
$function$;

-- Fix kpi_trial_to_paid to include 'paid' status
CREATE OR REPLACE FUNCTION public.kpi_trial_to_paid(p_range text DEFAULT '30d'::text)
 RETURNS TABLE(conversion_count bigint, total_revenue bigint, conversion_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text := get_system_timezone();
  v_start timestamptz;
  v_end timestamptz;
  v_total_trials bigint;
BEGIN
  CASE p_range
    WHEN '7d' THEN
      v_start := NOW() - INTERVAL '7 days';
    WHEN '30d' THEN
      v_start := NOW() - INTERVAL '30 days';
    WHEN '90d' THEN
      v_start := NOW() - INTERVAL '90 days';
    ELSE
      v_start := NOW() - INTERVAL '30 days';
  END CASE;
  v_end := NOW();

  -- Count total trials started in period
  SELECT COUNT(*) INTO v_total_trials
  FROM subscriptions
  WHERE trial_start >= v_start
    AND trial_start < v_end;

  RETURN QUERY
  SELECT 
    COUNT(*)::bigint as conversion_count,
    COALESCE(SUM(t.amount), 0)::bigint as total_revenue,
    CASE WHEN v_total_trials > 0 
      THEN ROUND((COUNT(*)::numeric / v_total_trials) * 100, 2)
      ELSE 0
    END as conversion_rate
  FROM transactions t
  WHERE t.payment_type = 'trial_conversion'
    AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
    AND COALESCE(t.stripe_created_at, t.created_at) < v_end
    AND t.status IN ('succeeded', 'paid');  -- Include both
END;
$function$;

-- Fix kpi_refunds to include 'paid' status when checking refunds
CREATE OR REPLACE FUNCTION public.kpi_refunds(p_range text DEFAULT '30d'::text)
 RETURNS TABLE(refund_count bigint, refund_amount bigint, currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
BEGIN
  CASE p_range
    WHEN '7d' THEN v_start := NOW() - INTERVAL '7 days';
    WHEN '30d' THEN v_start := NOW() - INTERVAL '30 days';
    WHEN '90d' THEN v_start := NOW() - INTERVAL '90 days';
    ELSE v_start := NOW() - INTERVAL '30 days';
  END CASE;

  RETURN QUERY
  SELECT 
    COUNT(*)::bigint as refund_count,
    COALESCE(ABS(SUM(t.amount)), 0)::bigint as refund_amount,
    COALESCE(t.currency, 'usd') as currency
  FROM transactions t
  WHERE (t.amount < 0 OR t.status IN ('refunded', 'disputed'))
    AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
  GROUP BY COALESCE(t.currency, 'usd');
END;
$function$;