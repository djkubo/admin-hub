-- =====================================================
-- EMERGENCY PERFORMANCE FIX - Part 1: Materialized View + RPC
-- =====================================================

-- 1. Create materialized view for client lifecycle counts (pre-computed)
-- This avoids scanning 221k+ rows on every dashboard load
DROP MATERIALIZED VIEW IF EXISTS mv_client_lifecycle_counts;
CREATE MATERIALIZED VIEW mv_client_lifecycle_counts AS
SELECT
  COUNT(*) FILTER (WHERE lifecycle_stage = 'LEAD') AS lead_count,
  COUNT(*) FILTER (WHERE lifecycle_stage = 'TRIAL') AS trial_count,
  COUNT(*) FILTER (WHERE lifecycle_stage = 'CUSTOMER') AS customer_count,
  COUNT(*) FILTER (WHERE lifecycle_stage = 'CHURN') AS churn_count,
  COUNT(*) FILTER (WHERE converted_at IS NOT NULL) AS converted_count,
  NOW() AS refreshed_at
FROM public.clients;

-- Create unique index for concurrent refresh
CREATE UNIQUE INDEX ON mv_client_lifecycle_counts (refreshed_at);

-- 2. Create normal index (not CONCURRENTLY) for KPI queries
CREATE INDEX IF NOT EXISTS idx_transactions_kpi_status_date 
ON public.transactions (status, stripe_created_at DESC)
WHERE status IN ('succeeded', 'paid', 'failed', 'refunded');

-- 3. Rewrite dashboard_metrics to use materialized view + efficient queries
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
  -- Use the covering index for sales aggregation - ONLY current month data
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
  -- Use materialized view for lifecycle counts (instant)
  lifecycle AS (
    SELECT * FROM mv_client_lifecycle_counts LIMIT 1
  ),
  -- Limit failed transactions query to last 30 days only
  failed_txs AS (
    SELECT 
      customer_email,
      SUM(amount) as total_amount,
      MIN(source) as source
    FROM transactions
    WHERE status IN ('failed', 'requires_payment_method', 'requires_action')
      AND customer_email IS NOT NULL
      AND stripe_created_at >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY customer_email
    ORDER BY SUM(amount) DESC
    LIMIT 50
  ),
  recovery AS (
    SELECT jsonb_agg(jsonb_build_object(
      'email', f.customer_email,
      'full_name', c.full_name,
      'phone', c.phone,
      'amount', f.total_amount / 100.0,
      'source', f.source
    )) AS list
    FROM failed_txs f
    LEFT JOIN clients c ON c.email = f.customer_email
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
    COALESCE(r.list, '[]'::jsonb)
  FROM sales_data s, lifecycle l, recovery r;
$$;

-- 4. Create function to refresh materialized view (to be called by cron)
CREATE OR REPLACE FUNCTION public.refresh_lifecycle_counts()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET statement_timeout TO '30s'
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_client_lifecycle_counts;
$$;

-- 5. Grant access to authenticated users
GRANT SELECT ON mv_client_lifecycle_counts TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lifecycle_counts() TO authenticated;