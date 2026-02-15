-- Expression index for kpi_sales RPC which uses COALESCE(stripe_created_at, created_at)
CREATE INDEX IF NOT EXISTS idx_transactions_coalesce_date
ON public.transactions (( COALESCE(stripe_created_at, created_at) ) DESC);

-- Composite with status for the WHERE clause
CREATE INDEX IF NOT EXISTS idx_transactions_status_coalesce_date
ON public.transactions (status, ( COALESCE(stripe_created_at, created_at) ) DESC)
WHERE status IN ('paid', 'succeeded');