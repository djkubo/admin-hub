-- ============================================
-- PERFORMANCE INDEXES FOR STRIPE/GHL/PAYPAL SYNC
-- ============================================

-- 1. Transactions table - Critical for metrics queries
CREATE INDEX IF NOT EXISTS idx_transactions_status_created 
ON public.transactions (status, stripe_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_source_status 
ON public.transactions (source, status);

CREATE INDEX IF NOT EXISTS idx_transactions_customer_email 
ON public.transactions (customer_email);

CREATE INDEX IF NOT EXISTS idx_transactions_stripe_pi 
ON public.transactions (stripe_payment_intent_id);

-- 2. Clients table - For fast lookups and sync
CREATE INDEX IF NOT EXISTS idx_clients_lifecycle_stage 
ON public.clients (lifecycle_stage);

CREATE INDEX IF NOT EXISTS idx_clients_payment_status 
ON public.clients (payment_status);

CREATE INDEX IF NOT EXISTS idx_clients_created_at 
ON public.clients (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer 
ON public.clients (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- 3. Subscriptions table - For MRR/churn queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_period 
ON public.subscriptions (status, current_period_end);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id 
ON public.subscriptions (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_email 
ON public.subscriptions (customer_email);

-- 4. Invoices table - For recovery and billing queries
CREATE INDEX IF NOT EXISTS idx_invoices_status_created 
ON public.invoices (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_email 
ON public.invoices (customer_email);

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_invoice_id 
ON public.invoices (stripe_invoice_id);

-- 5. Sync runs - For monitoring dashboard
CREATE INDEX IF NOT EXISTS idx_sync_runs_source_status 
ON public.sync_runs (source, status);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at 
ON public.sync_runs (started_at DESC);

-- 6. Lead events - For lead tracking
CREATE INDEX IF NOT EXISTS idx_lead_events_source_processed 
ON public.lead_events (source, processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_events_client_id 
ON public.lead_events (client_id);

-- 7. GHL contacts raw - For sync performance
CREATE INDEX IF NOT EXISTS idx_ghl_contacts_external_id 
ON public.ghl_contacts_raw (external_id);

CREATE INDEX IF NOT EXISTS idx_ghl_contacts_sync_run 
ON public.ghl_contacts_raw (sync_run_id);

-- 8. ManyChat contacts raw - For sync performance
CREATE INDEX IF NOT EXISTS idx_manychat_contacts_subscriber_id 
ON public.manychat_contacts_raw (subscriber_id);

-- 9. Run ANALYZE on critical tables
ANALYZE public.transactions;
ANALYZE public.clients;
ANALYZE public.subscriptions;
ANALYZE public.invoices;
ANALYZE public.sync_runs;