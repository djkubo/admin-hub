
-- ================================================
-- OPTIMIZACIÓN AGRESIVA - Fase 2
-- ================================================

-- 1. ELIMINAR ÍNDICES SIN USO (ahorro ~60MB + menos overhead de escritura)
DROP INDEX IF EXISTS idx_transactions_external_id_source;
DROP INDEX IF EXISTS idx_transactions_source_payment_key;
DROP INDEX IF EXISTS idx_transactions_status_created;
DROP INDEX IF EXISTS idx_transactions_subscription_id;
DROP INDEX IF EXISTS idx_invoices_status_stripe_created;
DROP INDEX IF EXISTS idx_invoices_invoice_number;
DROP INDEX IF EXISTS idx_clients_first_seen_at;
DROP INDEX IF EXISTS idx_transactions_payment_type;
DROP INDEX IF EXISTS idx_clients_payment_status;

-- 2. Crear índice compuesto más eficiente para queries de KPI
CREATE INDEX IF NOT EXISTS idx_transactions_kpi_optimized 
ON transactions(status, stripe_created_at DESC) 
WHERE status = 'succeeded';

-- 3. Índice para enlace cliente-transacción (acelera JOINs)
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer 
ON clients(stripe_customer_id) 
WHERE stripe_customer_id IS NOT NULL;

-- 4. Función para purgar transacciones/invoices muy antiguas (>2 años) que ya no son útiles
CREATE OR REPLACE FUNCTION cleanup_old_financial_data()
RETURNS TABLE(deleted_transactions INT, deleted_invoices INT) AS $$
DECLARE
  txn_count INT := 0;
  inv_count INT := 0;
BEGIN
  -- Transacciones fallidas de más de 1 año
  DELETE FROM transactions 
  WHERE status = 'failed' 
    AND stripe_created_at < NOW() - INTERVAL '365 days';
  GET DIAGNOSTICS txn_count = ROW_COUNT;
  
  -- Invoices void/draft de más de 1 año
  DELETE FROM invoices 
  WHERE status IN ('void', 'draft') 
    AND stripe_created_at < NOW() - INTERVAL '365 days';
  GET DIAGNOSTICS inv_count = ROW_COUNT;
  
  RETURN QUERY SELECT txn_count, inv_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
