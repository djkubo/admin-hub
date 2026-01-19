-- Add Stripe customer enrichment fields to clients table
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
ADD COLUMN IF NOT EXISTS total_spend INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS is_delinquent BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS customer_metadata JSONB DEFAULT '{}';

-- Index for stripe_customer_id lookups
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer_id ON public.clients(stripe_customer_id);

-- Index for delinquent customers (for recovery workflows)
CREATE INDEX IF NOT EXISTS idx_clients_is_delinquent ON public.clients(is_delinquent) WHERE is_delinquent = true;