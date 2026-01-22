-- Enriquecer tabla invoices con más datos de Stripe
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS customer_name TEXT,
ADD COLUMN IF NOT EXISTS invoice_number TEXT,
ADD COLUMN IF NOT EXISTS subscription_id TEXT,
ADD COLUMN IF NOT EXISTS plan_name TEXT,
ADD COLUMN IF NOT EXISTS plan_interval TEXT,
ADD COLUMN IF NOT EXISTS product_name TEXT,
ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS billing_reason TEXT,
ADD COLUMN IF NOT EXISTS collection_method TEXT,
ADD COLUMN IF NOT EXISTS description TEXT,
ADD COLUMN IF NOT EXISTS subtotal INTEGER,
ADD COLUMN IF NOT EXISTS total INTEGER,
ADD COLUMN IF NOT EXISTS amount_paid INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS amount_remaining INTEGER,
ADD COLUMN IF NOT EXISTS due_date TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS payment_intent_id TEXT,
ADD COLUMN IF NOT EXISTS charge_id TEXT,
ADD COLUMN IF NOT EXISTS default_payment_method TEXT,
ADD COLUMN IF NOT EXISTS last_finalization_error TEXT,
ADD COLUMN IF NOT EXISTS pdf_url TEXT,
ADD COLUMN IF NOT EXISTS lines JSONB;

-- Crear índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_invoices_subscription_id ON public.invoices(subscription_id);
CREATE INDEX IF NOT EXISTS idx_invoices_billing_reason ON public.invoices(billing_reason);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_name ON public.invoices(customer_name);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON public.invoices(invoice_number);