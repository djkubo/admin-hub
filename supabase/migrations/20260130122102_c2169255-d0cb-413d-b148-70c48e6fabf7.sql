-- =====================================================
-- ULTRA-FAST Dashboard Metrics - No Joins
-- =====================================================

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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout TO '8s'
SET search_path TO 'public'
AS $$
  WITH 
  -- Use index for sales aggregation - ONLY current month data
  sales_data AS (
    SELECT
      COALESCE(SUM(amount) FILTER (
        WHERE stripe_created_at >= CURRENT_DATE 
          AND (currency IS NULL OR lower(currency) = 'usd')
      ), 0) AS today_usd,
      COALESCE(SUM(amount) FILTER (
        WHERE stripe_created_at >= CURRENT_DATE 
          AND lower(currency) = 'mxn'
      ), 0) AS today_mxn,
      COALESCE(SUM(amount) FILTER (
        WHERE (currency IS NULL OR lower(currency) = 'usd')
      ), 0) AS month_usd,
      COALESCE(SUM(amount) FILTER (
        WHERE lower(currency) = 'mxn'
      ), 0) AS month_mxn
    FROM transactions
    WHERE stripe_created_at >= date_trunc('month', CURRENT_DATE)
      AND status IN ('succeeded', 'paid')
  ),
  -- Use materialized view for lifecycle counts (instant - 0ms)
  lifecycle AS (
    SELECT * FROM mv_client_lifecycle_counts LIMIT 1
  ),
  -- ULTRA-FAST: Get failed transactions WITHOUT joining to clients
  -- Just return email + amount, client lookup happens on frontend if needed
  failed_txs AS (
    SELECT 
      customer_email,
      SUM(amount)::numeric / 100 as total_amount,
      MIN(source) as source
    FROM transactions
    WHERE status IN ('failed', 'requires_payment_method', 'requires_action')
      AND customer_email IS NOT NULL
      AND stripe_created_at >= CURRENT_DATE - INTERVAL '14 days'
    GROUP BY customer_email
    ORDER BY SUM(amount) DESC
    LIMIT 20
  )
  SELECT
    s.today_usd::bigint,
    s.today_mxn::bigint,
    s.month_usd::bigint,
    s.month_mxn::bigint,
    l.trial_count::bigint,
    l.converted_count::bigint,
    l.churn_count::bigint,
    l.lead_count::bigint,
    l.customer_count::bigint,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'email', f.customer_email,
        'amount', f.total_amount,
        'source', f.source
      ))
      FROM failed_txs f
    ), '[]'::jsonb)
  FROM sales_data s, lifecycle l;
$$;