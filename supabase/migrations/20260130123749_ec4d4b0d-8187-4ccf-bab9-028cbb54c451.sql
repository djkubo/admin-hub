
-- Eliminar las versiones con parámetros que están causando ambigüedad
DROP FUNCTION IF EXISTS kpi_failed_payments(text);
DROP FUNCTION IF EXISTS kpi_new_customers(text, text, text);
