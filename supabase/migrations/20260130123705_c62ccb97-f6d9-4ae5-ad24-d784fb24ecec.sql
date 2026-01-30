
-- Limpiar todas las versiones de kpi_sales_summary y recrear una sola
DROP FUNCTION IF EXISTS kpi_sales_summary();
DROP FUNCTION IF EXISTS kpi_sales_summary(DATE);
DROP FUNCTION IF EXISTS kpi_sales_summary(DATE, DATE);
DROP FUNCTION IF EXISTS kpi_sales_summary(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION kpi_sales_summary()
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
