-- Add new columns to clients for tracking payment history
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'none',
ADD COLUMN IF NOT EXISTS total_paid numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS trial_started_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS converted_at timestamp with time zone;

-- Add source and transaction_id columns to transactions for deduplication
ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS source text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS external_transaction_id text;

-- Create unique index for deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id_source 
ON public.transactions(external_transaction_id, source) 
WHERE external_transaction_id IS NOT NULL;