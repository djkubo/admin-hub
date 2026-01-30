
-- OPTIMIZACIÓN CRÍTICA: Crear vista materializada para ventas del mes
-- Esto elimina la necesidad de escanear 12k+ transacciones cada vez

-- 1. Crear vista materializada para ventas del mes actual
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sales_summary AS
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
  ), 0) AS month_mxn,
  COALESCE(SUM(amount) FILTER (
    WHERE status = 'refunded' AND (currency IS NULL OR lower(currency) = 'usd')
  ), 0) AS refunds_usd,
  COALESCE(SUM(amount) FILTER (
    WHERE status = 'refunded' AND lower(currency) = 'mxn'
  ), 0) AS refunds_mxn,
  now() as last_refresh
FROM transactions
WHERE stripe_created_at >= date_trunc('month', CURRENT_DATE)
  AND status IN ('succeeded', 'paid', 'refunded');

-- 2. Crear índice único para REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS mv_sales_summary_idx ON mv_sales_summary (last_refresh);

-- 3. Actualizar dashboard_metrics para usar las vistas materializadas
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
STABLE SECURITY DEFINER
SET statement_timeout TO '5s'
SET search_path TO 'public'
AS $$
  -- ULTRA-FAST: Use pre-computed materialized views only
  WITH 
  sales AS (
    SELECT * FROM mv_sales_summary LIMIT 1
  ),
  lifecycle AS (
    SELECT * FROM mv_client_lifecycle_counts LIMIT 1
  ),
  -- Recovery list: Only top 10 failed in last 7 days
  failed_txs AS (
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
  FROM sales s, lifecycle l;
$$;

-- 4. Actualizar kpi_sales_summary para usar la vista materializada
CREATE OR REPLACE FUNCTION public.kpi_sales_summary()
RETURNS TABLE(
  sales_usd bigint,
  sales_mxn bigint,
  refunds_usd bigint,
  refunds_mxn bigint,
  today_usd bigint,
  today_mxn bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET statement_timeout TO '3s'
SET search_path TO 'public'
AS $$
  SELECT 
    month_usd::bigint as sales_usd,
    month_mxn::bigint as sales_mxn,
    refunds_usd::bigint,
    refunds_mxn::bigint,
    today_usd::bigint,
    today_mxn::bigint
  FROM mv_sales_summary
  LIMIT 1;
$$;

-- 5. Actualizar función de cleanup para refrescar vistas materializadas
CREATE OR REPLACE FUNCTION public.refresh_materialized_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Refresh sales summary (depends on today's date)
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_summary;
  
  -- Refresh client lifecycle counts
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_client_lifecycle_counts;
END;
$$;

-- 6. Crear función de mantenimiento automático mejorada
CREATE OR REPLACE FUNCTION public.cleanup_and_maintain()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- 1. Cleanup old data
  DELETE FROM webhook_events WHERE processed_at < now() - interval '3 days';
  DELETE FROM sync_runs WHERE started_at < now() - interval '7 days';
  DELETE FROM lead_events WHERE processed_at < now() - interval '7 days';
  DELETE FROM ghl_contacts_raw WHERE fetched_at < now() - interval '7 days';
  DELETE FROM manychat_contacts_raw WHERE fetched_at < now() - interval '7 days';
  DELETE FROM csv_imports_raw WHERE processed_at < now() - interval '7 days';
  DELETE FROM campaign_executions WHERE created_at < now() - interval '30 days';
  DELETE FROM flow_executions WHERE started_at < now() - interval '14 days';
  DELETE FROM client_events WHERE created_at < now() - interval '30 days';
  
  -- 2. Refresh materialized views
  PERFORM refresh_materialized_views();
END;
$$;

-- 7. RLS para las vistas materializadas
GRANT SELECT ON mv_sales_summary TO authenticated;
