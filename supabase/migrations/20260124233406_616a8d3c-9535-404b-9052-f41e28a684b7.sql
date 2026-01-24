-- ============================================================
-- COMMAND CENTER STABILIZATION: Raw JSONB + Performance Indexes
-- ============================================================

-- 1. Add raw_data JSONB columns to preserve complete API responses
-- Transactions
ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS raw_data JSONB DEFAULT NULL;

COMMENT ON COLUMN public.transactions.raw_data IS 'Complete raw API response from Stripe/PayPal for audit and future field extraction';

-- Subscriptions
ALTER TABLE public.subscriptions 
ADD COLUMN IF NOT EXISTS raw_data JSONB DEFAULT NULL;

COMMENT ON COLUMN public.subscriptions.raw_data IS 'Complete raw API response from Stripe/PayPal for audit';

-- Invoices
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS raw_data JSONB DEFAULT NULL;

COMMENT ON COLUMN public.invoices.raw_data IS 'Complete raw invoice data from Stripe';

-- 2. Performance indexes for Command Center analytics
-- Transactions: Most common query patterns
CREATE INDEX IF NOT EXISTS idx_transactions_status_created 
ON public.transactions(status, stripe_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_source_status 
ON public.transactions(source, status);

CREATE INDEX IF NOT EXISTS idx_transactions_customer_email_status 
ON public.transactions(customer_email, status);

CREATE INDEX IF NOT EXISTS idx_transactions_created_desc 
ON public.transactions(stripe_created_at DESC);

-- Subscriptions: Trial and status queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_trial 
ON public.subscriptions(status, trial_start, trial_end);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_email 
ON public.subscriptions(customer_email);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id 
ON public.subscriptions(stripe_subscription_id);

-- Invoices: Due date and status queries
CREATE INDEX IF NOT EXISTS idx_invoices_status_due 
ON public.invoices(status, due_date);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_email 
ON public.invoices(customer_email);

-- Sync runs: For checking active syncs
CREATE INDEX IF NOT EXISTS idx_sync_runs_source_status 
ON public.sync_runs(source, status);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at 
ON public.sync_runs(started_at DESC);

-- Clients: Lifecycle and sync queries
CREATE INDEX IF NOT EXISTS idx_clients_lifecycle_stage 
ON public.clients(lifecycle_stage);

CREATE INDEX IF NOT EXISTS idx_clients_last_sync 
ON public.clients(last_sync DESC);

-- 3. Enable realtime on tables not already added (skip transactions which is already there)
DO $$ 
BEGIN
  -- Try to add subscriptions (may already exist)
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.subscriptions;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  
  -- Try to add invoices (may already exist)
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.invoices;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  
  -- Try to add sync_runs (may already exist)
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_runs;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- 4. Analyze tables for query optimization
ANALYZE public.transactions;
ANALYZE public.subscriptions;
ANALYZE public.invoices;
ANALYZE public.clients;
ANALYZE public.sync_runs;