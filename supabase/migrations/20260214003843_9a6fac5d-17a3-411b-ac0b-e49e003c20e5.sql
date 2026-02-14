-- Index for clients ordered by trial_started_at DESC (paginated queries)
CREATE INDEX IF NOT EXISTS idx_clients_trial_started_desc
  ON public.clients (trial_started_at DESC NULLS LAST);

-- Partial index for transactions with succeeded/paid status + stripe_created_at DESC NULLS LAST
-- This covers the paginated query: status IN ('succeeded','paid') ORDER BY stripe_created_at DESC NULLS LAST
CREATE INDEX IF NOT EXISTS idx_transactions_success_paid_date
  ON public.transactions (stripe_created_at DESC NULLS LAST)
  WHERE status IN ('succeeded', 'paid');

-- Composite index on invoices for due_date queries with status
CREATE INDEX IF NOT EXISTS idx_invoices_due_date_status
  ON public.invoices (due_date, status);

-- Index for invoices automatically_finalizes_at
CREATE INDEX IF NOT EXISTS idx_invoices_auto_finalize
  ON public.invoices (automatically_finalizes_at)
  WHERE automatically_finalizes_at IS NOT NULL;