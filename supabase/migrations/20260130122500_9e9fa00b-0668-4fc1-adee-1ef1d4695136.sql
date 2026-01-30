
-- LIMPIEZA AGRESIVA DE ÍNDICES DUPLICADOS Y OPTIMIZACIÓN

-- 1. Eliminar índices duplicados en clients (hay varios duplicados)
DROP INDEX IF EXISTS idx_clients_email; -- duplicado de clients_email_unique
DROP INDEX IF EXISTS idx_clients_stripe_customer_id; -- duplicado de idx_clients_stripe_customer
DROP INDEX IF EXISTS idx_clients_manychat_subscriber_id; -- duplicado de idx_clients_manychat_id
DROP INDEX IF EXISTS idx_clients_ghl_contact_id; -- duplicado de idx_clients_ghl_id
DROP INDEX IF EXISTS idx_clients_paypal_customer_id; -- duplicado de idx_clients_paypal_id
DROP INDEX IF EXISTS idx_clients_metadata_gin; -- GIN index pesado, raramente usado
DROP INDEX IF EXISTS idx_clients_tracking_data; -- GIN index pesado, raramente usado

-- 2. Eliminar índices duplicados en invoices
DROP INDEX IF EXISTS idx_invoices_stripe_id; -- duplicado de invoices_stripe_invoice_id_key

-- 3. Eliminar índices duplicados en transactions  
DROP INDEX IF EXISTS idx_transactions_stripe_pi; -- duplicado de idx_transactions_stripe_payment_intent

-- 4. TRUNCATE de tablas temporales que acumulan dead tuples
TRUNCATE TABLE webhook_events RESTART IDENTITY;
TRUNCATE TABLE lead_events RESTART IDENTITY;

-- 5. Actualizar estadísticas para mejor planificación de queries
ANALYZE clients;
ANALYZE transactions;
ANALYZE invoices;
