-- Add paid_at column to invoices table for tracking when invoice was paid
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;

-- Add comment explaining the field
COMMENT ON COLUMN public.invoices.paid_at IS 'Timestamp when the invoice transitioned to paid status';