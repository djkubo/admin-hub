
-- Corregir el error de nested aggregate en dashboard_metrics
CREATE OR REPLACE FUNCTION public.dashboard_metrics()
RETURNS TABLE(
  sales_today_usd bigint,
  sales_today_mxn bigint,
  sales_month_usd bigint,
  sales_month_mxn bigint,
  trial_count bigint,
  converted_count bigint,
  churn_count bigint,
  lead_count bigint,
  customer_count bigint,
  recovery_list jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET statement_timeout TO '5s'
SET search_path TO 'public'
AS $$
DECLARE
  v_today_usd bigint;
  v_today_mxn bigint;
  v_month_usd bigint;
  v_month_mxn bigint;
  v_trial_count bigint;
  v_converted_count bigint;
  v_churn_count bigint;
  v_lead_count bigint;
  v_customer_count bigint;
  v_recovery_list jsonb;
BEGIN
  -- 1. Get sales from materialized view (instant - 0ms)
  SELECT s.today_usd, s.today_mxn, s.month_usd, s.month_mxn
  INTO v_today_usd, v_today_mxn, v_month_usd, v_month_mxn
  FROM mv_sales_summary s
  LIMIT 1;
  
  -- 2. Get lifecycle from materialized view (instant - 0ms)
  SELECT l.trial_count, l.converted_count, l.churn_count, l.lead_count, l.customer_count
  INTO v_trial_count, v_converted_count, v_churn_count, v_lead_count, v_customer_count
  FROM mv_client_lifecycle_counts l
  LIMIT 1;
  
  -- 3. Get recovery list (fast - ~150ms with index)
  -- First aggregate by email, then wrap in jsonb_agg
  WITH aggregated AS (
    SELECT 
      customer_email,
      SUM(amount)::numeric / 100 as total_amount,
      MIN(source) as source
    FROM transactions
    WHERE status IN ('failed', 'requires_payment_method', 'requires_action')
      AND customer_email IS NOT NULL
      AND stripe_created_at >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY customer_email
    ORDER BY SUM(amount) DESC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'email', a.customer_email,
    'amount', a.total_amount,
    'source', a.source
  )), '[]'::jsonb)
  INTO v_recovery_list
  FROM aggregated a;
  
  RETURN QUERY SELECT 
    COALESCE(v_today_usd, 0)::bigint,
    COALESCE(v_today_mxn, 0)::bigint,
    COALESCE(v_month_usd, 0)::bigint,
    COALESCE(v_month_mxn, 0)::bigint,
    COALESCE(v_trial_count, 0)::bigint,
    COALESCE(v_converted_count, 0)::bigint,
    COALESCE(v_churn_count, 0)::bigint,
    COALESCE(v_lead_count, 0)::bigint,
    COALESCE(v_customer_count, 0)::bigint,
    COALESCE(v_recovery_list, '[]'::jsonb);
END;
$$;
