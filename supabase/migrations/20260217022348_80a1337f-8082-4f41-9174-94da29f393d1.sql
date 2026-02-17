
-- ============================================================
-- FIX ALL 500/400 ERRORS
-- ============================================================

-- 0. Asegurar que system_settings exista
CREATE TABLE IF NOT EXISTS public.system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admin access system_settings" ON public.system_settings;
CREATE POLICY "Admin access system_settings" ON public.system_settings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "Service role system_settings" ON public.system_settings;
CREATE POLICY "Service role system_settings" ON public.system_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.system_settings TO authenticated, service_role;

-- 1. RECREAR mv_sales_summary
DROP MATERIALIZED VIEW IF EXISTS mv_sales_summary;
CREATE MATERIALIZED VIEW mv_sales_summary AS
SELECT
  COALESCE(SUM(amount) FILTER (WHERE stripe_created_at >= CURRENT_DATE AND (currency IS NULL OR lower(currency) = 'usd')), 0) AS today_usd,
  COALESCE(SUM(amount) FILTER (WHERE stripe_created_at >= CURRENT_DATE AND lower(currency) = 'mxn'), 0) AS today_mxn,
  COALESCE(SUM(amount) FILTER (WHERE (currency IS NULL OR lower(currency) = 'usd')), 0) AS month_usd,
  COALESCE(SUM(amount) FILTER (WHERE lower(currency) = 'mxn'), 0) AS month_mxn,
  COALESCE(SUM(amount) FILTER (WHERE status = 'refunded' AND (currency IS NULL OR lower(currency) = 'usd')), 0) AS refunds_usd,
  COALESCE(SUM(amount) FILTER (WHERE status = 'refunded' AND lower(currency) = 'mxn'), 0) AS refunds_mxn,
  now() as last_refresh
FROM transactions
WHERE stripe_created_at >= date_trunc('month', CURRENT_DATE)
  AND status IN ('succeeded', 'paid', 'refunded');
CREATE UNIQUE INDEX IF NOT EXISTS mv_sales_summary_idx ON mv_sales_summary (last_refresh);
REVOKE ALL ON mv_sales_summary FROM anon;
GRANT SELECT ON mv_sales_summary TO authenticated, service_role;

-- 2. RECREAR mv_client_lifecycle_counts
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
CREATE UNIQUE INDEX ON mv_client_lifecycle_counts (refreshed_at);
REVOKE ALL ON mv_client_lifecycle_counts FROM anon;
GRANT SELECT ON mv_client_lifecycle_counts TO authenticated, service_role;

-- 3. FIX kpi_sales_summary con fallback
DROP FUNCTION IF EXISTS public.kpi_sales_summary();
CREATE OR REPLACE FUNCTION public.kpi_sales_summary()
RETURNS TABLE(sales_usd bigint, sales_mxn bigint, refunds_usd bigint, refunds_mxn bigint, today_usd bigint, today_mxn bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET statement_timeout TO '5s'
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  RETURN QUERY SELECT s.month_usd::bigint, s.month_mxn::bigint, s.refunds_usd::bigint, s.refunds_mxn::bigint, s.today_usd::bigint, s.today_mxn::bigint FROM mv_sales_summary s LIMIT 1;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE (currency IS NULL OR lower(currency) = 'usd')), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE lower(currency) = 'mxn'), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status = 'refunded' AND (currency IS NULL OR lower(currency) = 'usd')), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status = 'refunded' AND lower(currency) = 'mxn'), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE stripe_created_at >= CURRENT_DATE AND (currency IS NULL OR lower(currency) = 'usd')), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE stripe_created_at >= CURRENT_DATE AND lower(currency) = 'mxn'), 0)::bigint
  FROM transactions WHERE stripe_created_at >= date_trunc('month', CURRENT_DATE) AND status IN ('succeeded', 'paid', 'refunded');
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.kpi_sales_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kpi_sales_summary() TO authenticated, service_role;

-- 4. FIX cleanup_old_data
DROP FUNCTION IF EXISTS public.cleanup_old_data();
CREATE OR REPLACE FUNCTION public.cleanup_old_data()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout TO '30s'
SET search_path TO 'public'
AS $function$
DECLARE v_ghl integer := 0; v_mc integer := 0; v_sr integer := 0; v_ev integer := 0; v_ce integer := 0;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  WITH d AS (DELETE FROM ghl_contacts_raw WHERE ctid IN (SELECT ctid FROM ghl_contacts_raw WHERE fetched_at < NOW() - INTERVAL '30 days' LIMIT 5000) RETURNING id) SELECT COUNT(*) INTO v_ghl FROM d;
  WITH d AS (DELETE FROM manychat_contacts_raw WHERE ctid IN (SELECT ctid FROM manychat_contacts_raw WHERE fetched_at < NOW() - INTERVAL '30 days' LIMIT 5000) RETURNING id) SELECT COUNT(*) INTO v_mc FROM d;
  WITH d AS (DELETE FROM sync_runs WHERE status IN ('completed','failed','error','cancelled') AND started_at < NOW() - INTERVAL '14 days' RETURNING id) SELECT COUNT(*) INTO v_sr FROM d;
  WITH d AS (DELETE FROM client_events WHERE ctid IN (SELECT ctid FROM client_events WHERE created_at < NOW() - INTERVAL '90 days' LIMIT 5000) RETURNING id) SELECT COUNT(*) INTO v_ev FROM d;
  WITH d AS (DELETE FROM campaign_executions WHERE created_at < NOW() - INTERVAL '60 days' RETURNING id) SELECT COUNT(*) INTO v_ce FROM d;
  RETURN jsonb_build_object('ghl_contacts_deleted', v_ghl, 'manychat_contacts_deleted', v_mc, 'sync_runs_deleted', v_sr, 'client_events_deleted', v_ev, 'campaign_executions_deleted', v_ce, 'executed_at', NOW());
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_old_data() TO authenticated, service_role;

-- 5. FIX data_quality_checks
DROP FUNCTION IF EXISTS public.data_quality_checks();
CREATE OR REPLACE FUNCTION public.data_quality_checks()
RETURNS TABLE(check_name text, severity text, affected_count bigint, percentage numeric, details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET statement_timeout TO '10s'
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  RETURN QUERY
  SELECT 'duplicate_emails'::text, CASE WHEN COUNT(*) > 0 THEN 'warning' ELSE 'ok' END::text, COUNT(*)::bigint, 0::numeric, '[]'::jsonb
  FROM (SELECT lower(trim(c.email)) FROM clients c WHERE c.email IS NOT NULL AND trim(c.email) <> '' GROUP BY lower(trim(c.email)) HAVING count(*) > 1) d
  UNION ALL
  SELECT 'clients_without_email'::text, CASE WHEN COUNT(*) > 100 THEN 'warning' ELSE 'info' END::text, COUNT(*)::bigint, ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM clients), 0), 2)::numeric, jsonb_build_object('total_clients', (SELECT COUNT(*) FROM clients))
  FROM clients WHERE email IS NULL OR trim(email) = ''
  UNION ALL
  SELECT 'orphan_transactions'::text, CASE WHEN COUNT(*) > 50 THEN 'warning' ELSE 'info' END::text, COUNT(*)::bigint, 0::numeric, jsonb_build_object('total_transactions', (SELECT COUNT(*) FROM transactions))
  FROM transactions t WHERE t.client_id IS NULL AND t.stripe_created_at >= NOW() - INTERVAL '30 days'
  UNION ALL
  SELECT 'stale_sync_runs'::text, CASE WHEN COUNT(*) > 0 THEN 'warning' ELSE 'ok' END::text, COUNT(*)::bigint, 0::numeric, '[]'::jsonb
  FROM sync_runs WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
  UNION ALL
  SELECT 'mixed_currencies'::text, CASE WHEN COUNT(DISTINCT t2.currency) > 1 THEN 'info' ELSE 'ok' END::text, COUNT(DISTINCT t2.currency)::bigint, 0::numeric, COALESCE(jsonb_agg(DISTINCT t2.currency), '[]'::jsonb)
  FROM transactions t2 WHERE t2.created_at >= NOW() - INTERVAL '30 days' AND t2.status IN ('succeeded', 'paid')
  UNION ALL
  SELECT 'clients_without_source'::text, CASE WHEN COUNT(*) FILTER (WHERE c4.acquisition_source IS NULL) * 100.0 / NULLIF(COUNT(*), 0) > 30 THEN 'warning' ELSE 'info' END::text, COUNT(*) FILTER (WHERE c4.acquisition_source IS NULL)::bigint, ROUND(COUNT(*) FILTER (WHERE c4.acquisition_source IS NULL) * 100.0 / NULLIF(COUNT(*), 0), 2)::numeric, jsonb_build_object('total', COUNT(*))
  FROM clients c4;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.data_quality_checks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.data_quality_checks() TO authenticated, service_role;

-- 6. FIX dashboard_metrics
DROP FUNCTION IF EXISTS public.dashboard_metrics();
CREATE OR REPLACE FUNCTION public.dashboard_metrics()
RETURNS TABLE(sales_today_usd bigint, sales_today_mxn bigint, sales_month_usd bigint, sales_month_mxn bigint, trial_count bigint, converted_count bigint, churn_count bigint, lead_count bigint, customer_count bigint, recovery_list jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET statement_timeout TO '8s'
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  RETURN QUERY
  WITH sales AS (SELECT * FROM mv_sales_summary LIMIT 1), lifecycle AS (SELECT * FROM mv_client_lifecycle_counts LIMIT 1),
    failed_txs AS (SELECT t.customer_email, SUM(t.amount) as total_amount, MIN(t.source) as source FROM transactions t WHERE t.status IN ('failed','requires_payment_method','requires_action') AND t.customer_email IS NOT NULL AND t.stripe_created_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY t.customer_email ORDER BY SUM(t.amount) DESC LIMIT 10)
  SELECT s.today_usd::bigint, s.today_mxn::bigint, s.month_usd::bigint, s.month_mxn::bigint, l.trial_count::bigint, l.converted_count::bigint, l.churn_count::bigint, l.lead_count::bigint, l.customer_count::bigint,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('email', f.customer_email, 'amount', f.total_amount / 100.0, 'source', f.source)) FROM failed_txs f), '[]'::jsonb)
  FROM sales s, lifecycle l;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.dashboard_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_metrics() TO authenticated, service_role;

-- 7. FIX refresh_materialized_views
CREATE OR REPLACE FUNCTION public.refresh_materialized_views()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout TO '60s'
SET search_path TO 'public'
AS $$ BEGIN REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_summary; REFRESH MATERIALIZED VIEW CONCURRENTLY mv_client_lifecycle_counts; END; $$;
GRANT EXECUTE ON FUNCTION public.refresh_materialized_views() TO authenticated, service_role;

-- 8. FIX rebuild_metrics_staging
DROP FUNCTION IF EXISTS public.rebuild_metrics_staging();
CREATE OR REPLACE FUNCTION public.rebuild_metrics_staging()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout TO '30s'
SET search_path TO 'public'
AS $function$
DECLARE v_kpis jsonb; v_st jsonb; v_sm jsonb; v_mrr jsonb; v_ch jsonb; v_nc jsonb; v_fp jsonb; v_rid uuid;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  INSERT INTO rebuild_logs (status, created_by) VALUES ('running', current_user) RETURNING id INTO v_rid;
  BEGIN REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_summary; REFRESH MATERIALIZED VIEW CONCURRENTLY mv_client_lifecycle_counts; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN SELECT jsonb_agg(row_to_json(s)) INTO v_st FROM kpi_sales('today') s; EXCEPTION WHEN OTHERS THEN v_st := '[]'::jsonb; END;
  BEGIN SELECT jsonb_agg(row_to_json(s)) INTO v_sm FROM kpi_sales('month') s; EXCEPTION WHEN OTHERS THEN v_sm := '[]'::jsonb; END;
  BEGIN SELECT jsonb_agg(row_to_json(m)) INTO v_mrr FROM kpi_mrr() m; EXCEPTION WHEN OTHERS THEN v_mrr := '[]'::jsonb; END;
  BEGIN SELECT jsonb_agg(row_to_json(c)) INTO v_ch FROM kpi_churn_30d() c; EXCEPTION WHEN OTHERS THEN v_ch := '[]'::jsonb; END;
  BEGIN SELECT row_to_json(n)::jsonb INTO v_nc FROM kpi_new_customers() n; EXCEPTION WHEN OTHERS THEN v_nc := '{}'::jsonb; END;
  BEGIN SELECT row_to_json(f)::jsonb INTO v_fp FROM kpi_failed_payments() f; EXCEPTION WHEN OTHERS THEN v_fp := '{}'::jsonb; END;
  v_kpis := jsonb_build_object('sales_today', COALESCE(v_st,'[]'::jsonb), 'sales_month', COALESCE(v_sm,'[]'::jsonb), 'mrr', COALESCE(v_mrr,'[]'::jsonb), 'churn_30d', COALESCE(v_ch,'[]'::jsonb), 'new_customers_month', COALESCE(v_nc,'{}'::jsonb), 'failed_payments_30d', COALESCE(v_fp,'{}'::jsonb), 'generated_at', now());
  INSERT INTO metrics_snapshots (snapshot_type, kpis) VALUES ('staging', v_kpis);
  UPDATE rebuild_logs SET status = 'completed', completed_at = now(), rows_processed = (SELECT COUNT(*) FROM transactions WHERE status IN ('succeeded','paid')) WHERE id = v_rid;
  RETURN v_kpis;
EXCEPTION WHEN OTHERS THEN
  UPDATE rebuild_logs SET status = 'error', completed_at = now(), errors = jsonb_build_object('message', SQLERRM, 'state', SQLSTATE) WHERE id = v_rid;
  RETURN jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rebuild_metrics_staging() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_metrics_staging() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
