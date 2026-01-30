-- ================================================
-- ARREGLAR RPCs para retornar formato de array
-- ================================================

-- 1. Recrear kpi_sales_summary con formato correcto
DROP FUNCTION IF EXISTS kpi_sales_summary();
CREATE FUNCTION kpi_sales_summary()
RETURNS JSON AS $$
BEGIN
  RETURN (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT 
        COALESCE(month_usd, 0) as sales_usd,
        COALESCE(month_mxn, 0) as sales_mxn,
        COALESCE(today_usd, 0) as today_usd,
        COALESCE(today_mxn, 0) as today_mxn,
        COALESCE(refunds_usd, 0) as refunds_usd,
        COALESCE(refunds_mxn, 0) as refunds_mxn
      FROM mv_sales_summary
      LIMIT 1
    ) t
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 2. Recrear dashboard_metrics con formato correcto  
DROP FUNCTION IF EXISTS dashboard_metrics();
CREATE FUNCTION dashboard_metrics()
RETURNS JSON AS $$
BEGIN
  RETURN (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT 
        COALESCE(lead_count, 0) as lead_count,
        COALESCE(trial_count, 0) as trial_count,
        COALESCE(customer_count, 0) as customer_count,
        COALESCE(churn_count, 0) as churn_count,
        (SELECT COUNT(*) FROM clients WHERE converted_at IS NOT NULL) as converted_count,
        '[]'::json as recovery_list
      FROM mv_client_lifecycle_counts
      LIMIT 1
    ) t
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;