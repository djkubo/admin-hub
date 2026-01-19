-- Add lifecycle_stage column to clients table
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS lifecycle_stage text DEFAULT 'LEAD';

-- Add comment for documentation
COMMENT ON COLUMN public.clients.lifecycle_stage IS 'Dynamic client lifecycle: LEAD, TRIAL, CUSTOMER, CHURN';

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_clients_lifecycle_stage ON public.clients(lifecycle_stage);