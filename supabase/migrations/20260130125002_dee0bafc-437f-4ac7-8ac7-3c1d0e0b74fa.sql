-- =====================================================
-- REPARACIÓN DE RPCs FALTANTES - FASE 1
-- Crea las 3 funciones que causan errores 500
-- =====================================================

-- 1. kpi_mrr_summary: MRR + Revenue at Risk desde subscriptions
DROP FUNCTION IF EXISTS public.kpi_mrr_summary();
CREATE OR REPLACE FUNCTION public.kpi_mrr_summary()
RETURNS TABLE(
  mrr bigint,
  active_count bigint,
  at_risk_amount bigint,
  at_risk_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout TO '10s'
AS $$
  SELECT 
    COALESCE(SUM(
      CASE 
        WHEN status IN ('active', 'trialing') THEN 
          CASE 
            WHEN interval = 'year' THEN amount / 12
            WHEN interval = 'week' THEN amount * 4
            ELSE amount
          END
        ELSE 0 
      END
    ), 0)::bigint AS mrr,
    COUNT(*) FILTER (WHERE status IN ('active', 'trialing'))::bigint AS active_count,
    COALESCE(SUM(
      CASE WHEN status IN ('past_due', 'unpaid') THEN amount ELSE 0 END
    ), 0)::bigint AS at_risk_amount,
    COUNT(*) FILTER (WHERE status IN ('past_due', 'unpaid'))::bigint AS at_risk_count
  FROM subscriptions;
$$;

-- 2. get_staging_counts_fast: Estimados instantáneos usando pg_stat
-- (Ya existe pero puede tener signature diferente - recreamos)
DROP FUNCTION IF EXISTS public.get_staging_counts_fast();
CREATE OR REPLACE FUNCTION public.get_staging_counts_fast()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT json_build_object(
    'ghl_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'ghl_contacts_raw'), 0),
    'ghl_unprocessed', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'ghl_contacts_raw'), 0),
    'manychat_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'manychat_contacts_raw'), 0),
    'manychat_unprocessed', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'manychat_contacts_raw'), 0),
    'csv_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'csv_imports_raw'), 0),
    'csv_staged', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'csv_imports_raw'), 0),
    'clients_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'clients'), 0),
    'transactions_total', COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'transactions'), 0)
  );
$$;

-- 3. kpi_invoices_summary: Agregados de facturas por status
DROP FUNCTION IF EXISTS public.kpi_invoices_summary();
CREATE OR REPLACE FUNCTION public.kpi_invoices_summary()
RETURNS TABLE(
  pending_total bigint,
  pending_count bigint,
  paid_total bigint,
  next_72h_total bigint,
  next_72h_count bigint,
  uncollectible_total bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout TO '10s'
AS $$
  SELECT 
    COALESCE(SUM(amount_due) FILTER (WHERE status IN ('open', 'draft')), 0)::bigint,
    COUNT(*) FILTER (WHERE status IN ('open', 'draft'))::bigint,
    COALESCE(SUM(amount_paid) FILTER (WHERE status = 'paid'), 0)::bigint,
    COALESCE(SUM(amount_due) FILTER (WHERE status IN ('open', 'draft') AND next_payment_attempt <= NOW() + INTERVAL '72 hours'), 0)::bigint,
    COUNT(*) FILTER (WHERE status IN ('open', 'draft') AND next_payment_attempt <= NOW() + INTERVAL '72 hours')::bigint,
    COALESCE(SUM(amount_due) FILTER (WHERE status = 'uncollectible'), 0)::bigint
  FROM invoices;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.kpi_mrr_summary() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_staging_counts_fast() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_invoices_summary() TO anon, authenticated;