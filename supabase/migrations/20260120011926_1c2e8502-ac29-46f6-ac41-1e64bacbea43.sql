-- Add payment_key column for canonical deduplication
ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS payment_key text;

-- Create unique constraint on (source, payment_key) for perfect deduplication
-- First drop existing constraint if any
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_source_payment_key_unique;

-- Create the new unique constraint
ALTER TABLE public.transactions 
ADD CONSTRAINT transactions_source_payment_key_unique UNIQUE (source, payment_key);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_transactions_source_payment_key 
ON public.transactions(source, payment_key);

-- Normalize existing data: populate payment_key from existing columns
-- For Stripe: use stripe_payment_intent_id if it's a real pi_ ID, else use charge pattern
-- For PayPal: use external_transaction_id
UPDATE public.transactions 
SET payment_key = CASE 
  WHEN source = 'paypal' THEN 
    COALESCE(external_transaction_id, REPLACE(stripe_payment_intent_id, 'paypal_', ''))
  WHEN source = 'stripe' THEN 
    CASE 
      WHEN stripe_payment_intent_id LIKE 'pi_%' THEN stripe_payment_intent_id
      WHEN stripe_payment_intent_id LIKE 'ch_%' THEN stripe_payment_intent_id
      WHEN stripe_payment_intent_id LIKE 'in_%' THEN stripe_payment_intent_id
      ELSE stripe_payment_intent_id
    END
  ELSE stripe_payment_intent_id
END
WHERE payment_key IS NULL;