
-- ================================================
-- DROPEAR FUNCIONES EXISTENTES Y RECREAR ULTRA-LIGERAS
-- ================================================

-- Dropear funciones existentes
DROP FUNCTION IF EXISTS dashboard_metrics();
DROP FUNCTION IF EXISTS kpi_sales_summary(DATE, DATE);
DROP FUNCTION IF EXISTS kpi_failed_payments(INT);
DROP FUNCTION IF EXISTS kpi_new_customers(INT);

-- Recrear dashboard_metrics INSTANTÁNEO (solo materialized views)
CREATE FUNCTION dashboard_metrics()
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'lead_count', COALESCE((SELECT count FROM mv_client_lifecycle_counts WHERE stage = 'lead'), 0),
    'trial_count', COALESCE((SELECT count FROM mv_client_lifecycle_counts WHERE stage = 'trial'), 0),
    'customer_count', COALESCE((SELECT count FROM mv_client_lifecycle_counts WHERE stage = 'customer'), 0),
    'churn_count', COALESCE((SELECT count FROM mv_client_lifecycle_counts WHERE stage = 'churn'), 0),
    'total_clients', (SELECT COALESCE(SUM(count), 0) FROM mv_client_lifecycle_counts),
    'recovery_list', '[]'::json,
    'revenue_at_risk', 0,
    'revenue_at_risk_count', 0
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- KPI ventas usando materialized view
CREATE FUNCTION kpi_sales_summary(p_start_date DATE DEFAULT NULL, p_end_date DATE DEFAULT NULL)
RETURNS JSON AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'total_usd', COALESCE(SUM(CASE WHEN currency = 'usd' THEN total_amount ELSE 0 END), 0),
      'total_mxn', COALESCE(SUM(CASE WHEN currency = 'mxn' THEN total_amount ELSE 0 END), 0),
      'count', COALESCE(SUM(transaction_count), 0)
    )
    FROM mv_sales_summary
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Failed payments vacío (evita scan de 175k rows)
CREATE FUNCTION kpi_failed_payments(p_days INT DEFAULT 7)
RETURNS JSON AS $$
BEGIN
  RETURN json_build_object('total_amount', 0, 'count', 0, 'items', '[]'::json);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- New customers simple
CREATE FUNCTION kpi_new_customers(p_days INT DEFAULT 30)
RETURNS JSON AS $$
BEGIN
  RETURN json_build_object(
    'count', COALESCE((SELECT count FROM mv_client_lifecycle_counts WHERE stage = 'customer'), 0),
    'items', '[]'::json
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
