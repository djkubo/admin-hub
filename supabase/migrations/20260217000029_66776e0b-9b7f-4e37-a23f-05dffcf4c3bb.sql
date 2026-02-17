
-- Fix rebuild_metrics_staging timeout: increase to 120s for maintenance operation
DROP FUNCTION IF EXISTS public.rebuild_metrics_staging();

CREATE OR REPLACE FUNCTION public.rebuild_metrics_staging()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout = '120s'
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

REVOKE EXECUTE ON FUNCTION public.rebuild_metrics_staging() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_metrics_staging() TO authenticated, service_role;
