
-- Limpiar TODAS las versiones duplicadas de las funciones de KPI
DROP FUNCTION IF EXISTS kpi_failed_payments();
DROP FUNCTION IF EXISTS kpi_failed_payments(INT);
DROP FUNCTION IF EXISTS kpi_failed_payments(INTEGER);
DROP FUNCTION IF EXISTS kpi_new_customers();
DROP FUNCTION IF EXISTS kpi_new_customers(INT);
DROP FUNCTION IF EXISTS kpi_new_customers(INTEGER);

-- Recrear versiones simples sin parámetros
CREATE FUNCTION kpi_failed_payments()
RETURNS JSON AS $$
BEGIN
  RETURN json_build_object('total_amount', 0, 'count', 0, 'items', '[]'::json);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE FUNCTION kpi_new_customers()
RETURNS JSON AS $$
BEGIN
  RETURN json_build_object(
    'count', COALESCE((SELECT customer_count FROM mv_client_lifecycle_counts LIMIT 1), 0),
    'items', '[]'::json
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
