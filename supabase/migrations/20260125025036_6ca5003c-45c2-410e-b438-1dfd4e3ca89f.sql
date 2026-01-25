-- Add missing columns to invoices table for full Stripe mirror
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS stripe_created_at timestamptz,
ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
ADD COLUMN IF NOT EXISTS automatically_finalizes_at timestamptz,
ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_invoices_status_stripe_created 
ON public.invoices(status, stripe_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_email 
ON public.invoices(customer_email);

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_customer_id 
ON public.invoices(stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number 
ON public.invoices(invoice_number);