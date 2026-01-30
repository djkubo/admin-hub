
-- ================================================
-- ARREGLAR RPCs para usar estructura correcta de MVs
-- ================================================

-- Dropear y recrear dashboard_metrics con columnas correctas
DROP FUNCTION IF EXISTS dashboard_metrics();
CREATE FUNCTION dashboard_metrics()
RETURNS JSON AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'lead_count', COALESCE(lead_count, 0),
      'trial_count', COALESCE(trial_count, 0),
      'customer_count', COALESCE(customer_count, 0),
      'churn_count', COALESCE(churn_count, 0),
      'total_clients', COALESCE(lead_count + trial_count + customer_count + churn_count, 0),
      'recovery_list', '[]'::json,
      'revenue_at_risk', 0,
      'revenue_at_risk_count', 0
    )
    FROM mv_client_lifecycle_counts
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Arreglar kpi_sales_summary para usar columnas correctas
DROP FUNCTION IF EXISTS kpi_sales_summary(DATE, DATE);
CREATE FUNCTION kpi_sales_summary(p_start_date DATE DEFAULT NULL, p_end_date DATE DEFAULT NULL)
RETURNS JSON AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'total_usd', COALESCE(month_usd, 0) / 100.0,
      'total_mxn', COALESCE(month_mxn, 0) / 100.0,
      'today_usd', COALESCE(today_usd, 0) / 100.0,
      'today_mxn', COALESCE(today_mxn, 0) / 100.0,
      'refunds_usd', COALESCE(refunds_usd, 0) / 100.0,
      'refunds_mxn', COALESCE(refunds_mxn, 0) / 100.0
    )
    FROM mv_sales_summary
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
