-- ============================================
-- VERIFY & ADD MISSING COLUMNS IN MAIN TABLES
-- Created: 2026-01-26
-- Purpose: Ensure all tables have columns expected by Edge Functions
-- ============================================

-- ============================================
-- TRANSACTIONS TABLE
-- ============================================

ALTER TABLE public.transactions 
ADD COLUMN IF NOT EXISTS external_transaction_id text,
ADD COLUMN IF NOT EXISTS payment_key text,
ADD COLUMN IF NOT EXISTS payment_type text DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS subscription_id text,
ADD COLUMN IF NOT EXISTS source text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS raw_data jsonb;

-- Unique constraint on payment_key + source
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'transactions_source_payment_key_unique'
  ) THEN
    ALTER TABLE public.transactions 
    ADD CONSTRAINT transactions_source_payment_key_unique 
    UNIQUE (source, payment_key);
  END IF;
END $$;

-- Index for payment_key lookups
CREATE INDEX IF NOT EXISTS idx_transactions_source_payment_key 
ON public.transactions(source, payment_key);

-- ============================================
-- INVOICES TABLE
-- ============================================

ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS invoice_number text,
ADD COLUMN IF NOT EXISTS customer_name text,
ADD COLUMN IF NOT EXISTS customer_phone text,
ADD COLUMN IF NOT EXISTS amount_paid integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS amount_remaining integer,
ADD COLUMN IF NOT EXISTS subtotal integer,
ADD COLUMN IF NOT EXISTS total integer,
ADD COLUMN IF NOT EXISTS stripe_created_at timestamptz,
ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
ADD COLUMN IF NOT EXISTS paid_at timestamptz,
ADD COLUMN IF NOT EXISTS automatically_finalizes_at timestamptz,
ADD COLUMN IF NOT EXISTS due_date timestamptz,
ADD COLUMN IF NOT EXISTS pdf_url text,
ADD COLUMN IF NOT EXISTS subscription_id text,
ADD COLUMN IF NOT EXISTS plan_name text,
ADD COLUMN IF NOT EXISTS plan_interval text,
ADD COLUMN IF NOT EXISTS product_name text,
ADD COLUMN IF NOT EXISTS billing_reason text,
ADD COLUMN IF NOT EXISTS collection_method text,
ADD COLUMN IF NOT EXISTS description text,
ADD COLUMN IF NOT EXISTS payment_intent_id text,
ADD COLUMN IF NOT EXISTS charge_id text,
ADD COLUMN IF NOT EXISTS default_payment_method text,
ADD COLUMN IF NOT EXISTS last_finalization_error text,
ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS lines jsonb,
ADD COLUMN IF NOT EXISTS raw_data jsonb;

-- Index for client_id lookups
CREATE INDEX IF NOT EXISTS idx_invoices_client_id 
ON public.invoices(client_id) 
WHERE client_id IS NOT NULL;

-- ============================================
-- SUBSCRIPTIONS TABLE
-- ============================================

ALTER TABLE public.subscriptions 
ADD COLUMN IF NOT EXISTS provider text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS trial_start timestamptz,
ADD COLUMN IF NOT EXISTS trial_end timestamptz,
ADD COLUMN IF NOT EXISTS cancel_reason text,
ADD COLUMN IF NOT EXISTS raw_data jsonb;

-- Index for provider lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider 
ON public.subscriptions(provider);

-- ============================================
-- MESSAGES TABLE (if exists)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'messages') THEN
    -- Ensure messages table has all required columns
    ALTER TABLE public.messages 
    ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS direction text CHECK (direction IN ('inbound', 'outbound')),
    ADD COLUMN IF NOT EXISTS channel text CHECK (channel IN ('sms', 'whatsapp', 'email')),
    ADD COLUMN IF NOT EXISTS from_address text,
    ADD COLUMN IF NOT EXISTS to_address text,
    ADD COLUMN IF NOT EXISTS subject text,
    ADD COLUMN IF NOT EXISTS body text NOT NULL,
    ADD COLUMN IF NOT EXISTS external_message_id text,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'sent' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
    ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
    ADD COLUMN IF NOT EXISTS read_at timestamptz;
  END IF;
END $$;

-- ============================================
-- CLIENT_EVENTS TABLE (if exists)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'client_events') THEN
    ALTER TABLE public.client_events 
    ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS event_type text,
    ADD COLUMN IF NOT EXISTS metadata jsonb,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
  END IF;
END $$;

-- ============================================
-- CAMPAIGNS TABLES (if exist)
-- ============================================

DO $$
BEGIN
  -- campaign_rules
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'campaign_rules') THEN
    ALTER TABLE public.campaign_rules 
    ADD COLUMN IF NOT EXISTS id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS trigger_event text NOT NULL,
    ADD COLUMN IF NOT EXISTS template_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS max_attempts integer,
    ADD COLUMN IF NOT EXISTS delay_minutes integer,
    ADD COLUMN IF NOT EXISTS channel_priority text[],
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
  END IF;
  
  -- campaign_executions
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'campaign_executions') THEN
    ALTER TABLE public.campaign_executions 
    ADD COLUMN IF NOT EXISTS id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS rule_id uuid REFERENCES public.campaign_rules(id),
    ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id),
    ADD COLUMN IF NOT EXISTS trigger_event text NOT NULL,
    ADD COLUMN IF NOT EXISTS status text NOT NULL,
    ADD COLUMN IF NOT EXISTS channel_used text,
    ADD COLUMN IF NOT EXISTS message_content text,
    ADD COLUMN IF NOT EXISTS external_message_id text,
    ADD COLUMN IF NOT EXISTS attempt_number integer,
    ADD COLUMN IF NOT EXISTS revenue_at_risk numeric,
    ADD COLUMN IF NOT EXISTS metadata jsonb,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- ============================================
-- OPT_OUTS TABLE (if exists)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'opt_outs') THEN
    ALTER TABLE public.opt_outs 
    ADD COLUMN IF NOT EXISTS id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS channel text NOT NULL,
    ADD COLUMN IF NOT EXISTS reason text,
    ADD COLUMN IF NOT EXISTS opted_out_at timestamptz DEFAULT now();
  END IF;
END $$;

-- ============================================
-- SYSTEM_SETTINGS TABLE (if exists)
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'system_settings') THEN
    CREATE TABLE public.system_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      value text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    
    ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
    
    CREATE POLICY "Admin can manage system_settings" ON public.system_settings
      FOR ALL USING (is_admin()) WITH CHECK (is_admin());
  END IF;
END $$;

-- ============================================
-- UPDATE EXISTING DATA
-- ============================================

-- Populate payment_key for existing transactions if missing
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
WHERE payment_key IS NULL AND stripe_payment_intent_id IS NOT NULL;

-- Populate phone_e164 for existing clients if missing
UPDATE public.clients 
SET phone_e164 = normalize_phone_e164(phone)
WHERE phone IS NOT NULL 
  AND phone_e164 IS NULL;

-- ============================================
-- ANALYZE FOR QUERY OPTIMIZATION
-- ============================================

ANALYZE public.transactions;
ANALYZE public.invoices;
ANALYZE public.subscriptions;
