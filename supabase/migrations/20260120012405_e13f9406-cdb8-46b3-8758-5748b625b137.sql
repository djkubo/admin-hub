-- A) Ampliar tabla subscriptions con campos de trial y provider
ALTER TABLE public.subscriptions 
ADD COLUMN IF NOT EXISTS provider text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS trial_start timestamp with time zone,
ADD COLUMN IF NOT EXISTS trial_end timestamp with time zone,
ADD COLUMN IF NOT EXISTS cancel_reason text;

-- B) Agregar payment_type a transactions para clasificación
ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS payment_type text DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS subscription_id text;

-- Crear índice para búsquedas por subscription_id
CREATE INDEX IF NOT EXISTS idx_transactions_subscription_id 
ON public.transactions(subscription_id);

-- Crear índice para búsquedas por payment_type
CREATE INDEX IF NOT EXISTS idx_transactions_payment_type 
ON public.transactions(payment_type);

-- Crear índice para filtros de fecha
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_created_at 
ON public.transactions(stripe_created_at);

-- Crear índice para subscriptions por provider
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider 
ON public.subscriptions(provider);