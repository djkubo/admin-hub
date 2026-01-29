-- ============================================
-- FASE 1: RPC get_staging_counts_accurate + Índices Parciales
-- Optimización para 800k+ registros en unificación masiva
-- ============================================

-- Crear índices parciales para acelerar conteos de pendientes (CONCURRENTLY no disponible)
CREATE INDEX IF NOT EXISTS idx_ghl_raw_unprocessed 
ON ghl_contacts_raw (id) 
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_manychat_raw_unprocessed 
ON manychat_contacts_raw (id) 
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_csv_raw_staged 
ON csv_imports_raw (id) 
WHERE processing_status IN ('staged', 'pending');

-- Crear RPC con conteos EXACTOS (no estimaciones) pero con timeout de seguridad
CREATE OR REPLACE FUNCTION public.get_staging_counts_accurate()
RETURNS JSON
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET statement_timeout = '10s'
AS $$
  SELECT json_build_object(
    'ghl_total', COALESCE((SELECT COUNT(*) FROM ghl_contacts_raw), 0),
    'ghl_unprocessed', COALESCE((SELECT COUNT(*) FROM ghl_contacts_raw WHERE processed_at IS NULL), 0),
    'manychat_total', COALESCE((SELECT COUNT(*) FROM manychat_contacts_raw), 0),
    'manychat_unprocessed', COALESCE((SELECT COUNT(*) FROM manychat_contacts_raw WHERE processed_at IS NULL), 0),
    'csv_total', COALESCE((SELECT COUNT(*) FROM csv_imports_raw), 0),
    'csv_staged', COALESCE((SELECT COUNT(*) FROM csv_imports_raw WHERE processing_status IN ('staged', 'pending')), 0),
    'clients_total', COALESCE((SELECT COUNT(*) FROM clients), 0),
    'transactions_total', COALESCE((SELECT COUNT(*) FROM transactions), 0)
  );
$$;

-- Notificar a PostgREST para que recargue el schema
NOTIFY pgrst, 'reload schema';