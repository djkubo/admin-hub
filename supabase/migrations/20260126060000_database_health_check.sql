-- ============================================
-- DATABASE HEALTH CHECK & FIXES
-- Created: 2026-01-26
-- Purpose: Verify and fix any structural issues
-- ============================================

-- ============================================
-- 1. VERIFY CLIENTS TABLE STRUCTURE
-- ============================================

-- Ensure clients table has UUID id as primary key
DO $$
BEGIN
  -- Check if id column exists and is primary key
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'clients' 
    AND constraint_type = 'PRIMARY KEY'
    AND constraint_name LIKE '%id%'
  ) THEN
    -- Add id if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'clients' AND column_name = 'id'
    ) THEN
      ALTER TABLE public.clients ADD COLUMN id UUID DEFAULT gen_random_uuid();
      UPDATE public.clients SET id = gen_random_uuid() WHERE id IS NULL;
      ALTER TABLE public.clients ALTER COLUMN id SET NOT NULL;
      ALTER TABLE public.clients ADD PRIMARY KEY (id);
    END IF;
  END IF;
END $$;

-- Ensure email has unique constraint (not primary key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'clients' 
    AND constraint_type = 'UNIQUE'
    AND constraint_name LIKE '%email%'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS clients_email_unique 
    ON public.clients(email) 
    WHERE email IS NOT NULL;
  END IF;
END $$;

-- ============================================
-- 2. VERIFY REQUIRED COLUMNS IN CLIENTS
-- ============================================

-- Add missing columns that Edge Functions expect
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
ADD COLUMN IF NOT EXISTS phone_e164 text,
ADD COLUMN IF NOT EXISTS tracking_data jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS last_attribution_at timestamptz,
ADD COLUMN IF NOT EXISTS paypal_customer_id text,
ADD COLUMN IF NOT EXISTS stripe_customer_id text,
ADD COLUMN IF NOT EXISTS ghl_contact_id text,
ADD COLUMN IF NOT EXISTS manychat_subscriber_id text,
ADD COLUMN IF NOT EXISTS wa_opt_in boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS sms_opt_in boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS email_opt_in boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS lifecycle_stage text DEFAULT 'LEAD',
ADD COLUMN IF NOT EXISTS lead_status text,
ADD COLUMN IF NOT EXISTS status text DEFAULT 'active',
ADD COLUMN IF NOT EXISTS payment_status text,
ADD COLUMN IF NOT EXISTS total_paid numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_spend numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS is_delinquent boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS review_reason text,
ADD COLUMN IF NOT EXISTS revenue_score numeric,
ADD COLUMN IF NOT EXISTS converted_at timestamptz,
ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
ADD COLUMN IF NOT EXISTS last_lead_at timestamptz,
ADD COLUMN IF NOT EXISTS acquisition_source text,
ADD COLUMN IF NOT EXISTS acquisition_campaign text,
ADD COLUMN IF NOT EXISTS acquisition_medium text,
ADD COLUMN IF NOT EXISTS acquisition_content text,
ADD COLUMN IF NOT EXISTS utm_source text,
ADD COLUMN IF NOT EXISTS utm_medium text,
ADD COLUMN IF NOT EXISTS utm_campaign text,
ADD COLUMN IF NOT EXISTS utm_content text,
ADD COLUMN IF NOT EXISTS utm_term text,
ADD COLUMN IF NOT EXISTS customer_metadata jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS last_sync timestamptz DEFAULT now(),
ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- ============================================
-- 3. VERIFY SYNC_RUNS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  total_fetched integer DEFAULT 0,
  total_inserted integer DEFAULT 0,
  total_updated integer DEFAULT 0,
  total_skipped integer DEFAULT 0,
  total_conflicts integer DEFAULT 0,
  dry_run boolean DEFAULT false,
  error_message text,
  checkpoint jsonb,
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Indexes for sync_runs
CREATE INDEX IF NOT EXISTS idx_sync_runs_source_status 
ON public.sync_runs(source, status);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at 
ON public.sync_runs(started_at DESC);

-- ============================================
-- 4. VERIFY MERGE_CONFLICTS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.merge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text NOT NULL,
  conflict_type text NOT NULL,
  email_found text,
  phone_found text,
  raw_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resolution text,
  resolved_at timestamptz,
  resolved_by text,
  suggested_client_id uuid REFERENCES public.clients(id),
  sync_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================
-- 5. VERIFY CONTACT_IDENTITIES TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text NOT NULL,
  email_normalized text,
  phone_e164 text,
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint on source + external_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identities_source_external_unique 
ON public.contact_identities(source, external_id);

-- ============================================
-- 6. VERIFY REQUIRED FUNCTIONS EXIST
-- ============================================

-- is_admin function
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_admins
    WHERE user_id = auth.uid()
  );
$$;

-- normalize_email function
CREATE OR REPLACE FUNCTION public.normalize_email(email text)
RETURNS text AS $$
BEGIN
  IF email IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN lower(trim(email));
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- normalize_phone_e164 function
CREATE OR REPLACE FUNCTION public.normalize_phone_e164(phone text)
RETURNS text AS $$
DECLARE
  cleaned text;
BEGIN
  IF phone IS NULL OR phone = '' THEN
    RETURN NULL;
  END IF;
  
  -- Remove all non-digit characters except +
  cleaned := regexp_replace(phone, '[^0-9+]', '', 'g');
  
  -- If starts with +, keep it
  IF left(cleaned, 1) = '+' THEN
    cleaned := '+' || regexp_replace(substring(cleaned from 2), '[^0-9]', '', 'g');
  ELSE
    -- Remove leading zeros
    cleaned := regexp_replace(cleaned, '^0+', '');
    -- Add + if not present and looks like international
    IF length(cleaned) >= 10 THEN
      cleaned := '+' || cleaned;
    END IF;
  END IF;
  
  -- Validate minimum length for E.164
  IF length(regexp_replace(cleaned, '[^0-9]', '', 'g')) < 10 THEN
    RETURN NULL;
  END IF;
  
  RETURN cleaned;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- ============================================
-- 7. VERIFY INDEXES FOR PERFORMANCE
-- ============================================

-- Clients indexes
CREATE INDEX IF NOT EXISTS idx_clients_email_lower 
ON public.clients(LOWER(email)) 
WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_phone_e164 
ON public.clients(phone_e164) 
WHERE phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer_id 
ON public.clients(stripe_customer_id) 
WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_paypal_customer_id 
ON public.clients(paypal_customer_id) 
WHERE paypal_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_ghl_contact_id 
ON public.clients(ghl_contact_id) 
WHERE ghl_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_manychat_subscriber_id 
ON public.clients(manychat_subscriber_id) 
WHERE manychat_subscriber_id IS NOT NULL;

-- Transactions indexes
CREATE INDEX IF NOT EXISTS idx_transactions_customer_email 
ON public.transactions(customer_email) 
WHERE customer_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_stripe_customer_id 
ON public.transactions(stripe_customer_id) 
WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_status_created 
ON public.transactions(status, stripe_created_at DESC);

-- Invoices indexes
CREATE INDEX IF NOT EXISTS idx_invoices_client_id 
ON public.invoices(client_id) 
WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_customer_id 
ON public.invoices(stripe_customer_id) 
WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_status_due 
ON public.invoices(status, due_date);

-- Subscriptions indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id 
ON public.subscriptions(stripe_customer_id) 
WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_status_trial 
ON public.subscriptions(status, trial_start, trial_end);

-- ============================================
-- 8. VERIFY FOREIGN KEY CONSTRAINTS
-- ============================================

-- Ensure foreign keys exist where needed
DO $$
BEGIN
  -- messages.client_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'messages_client_id_fkey'
  ) THEN
    ALTER TABLE public.messages 
    ADD CONSTRAINT messages_client_id_fkey 
    FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;
  
  -- invoices.client_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'invoices_client_id_fkey'
  ) THEN
    ALTER TABLE public.invoices 
    ADD CONSTRAINT invoices_client_id_fkey 
    FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
  END IF;
  
  -- campaign_recipients.client_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'campaign_recipients_client_id_fkey'
  ) THEN
    ALTER TABLE public.campaign_recipients 
    ADD CONSTRAINT campaign_recipients_client_id_fkey 
    FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ============================================
-- 9. VERIFY RLS POLICIES
-- ============================================

-- Ensure RLS is enabled
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merge_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;

-- Ensure admin policies exist
DO $$
BEGIN
  -- sync_runs
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'sync_runs' AND policyname LIKE '%admin%'
  ) THEN
    DROP POLICY IF EXISTS "Admin can manage sync_runs" ON public.sync_runs;
    CREATE POLICY "Admin can manage sync_runs" ON public.sync_runs
      FOR ALL USING (is_admin()) WITH CHECK (is_admin());
  END IF;
  
  -- merge_conflicts
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'merge_conflicts' AND policyname LIKE '%admin%'
  ) THEN
    DROP POLICY IF EXISTS "Admin can manage merge_conflicts" ON public.merge_conflicts;
    CREATE POLICY "Admin can manage merge_conflicts" ON public.merge_conflicts
      FOR ALL USING (is_admin()) WITH CHECK (is_admin());
  END IF;
  
  -- contact_identities
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'contact_identities' AND policyname LIKE '%admin%'
  ) THEN
    DROP POLICY IF EXISTS "Admin can manage contact_identities" ON public.contact_identities;
    CREATE POLICY "Admin can manage contact_identities" ON public.contact_identities
      FOR ALL USING (is_admin()) WITH CHECK (is_admin());
  END IF;
END $$;

-- ============================================
-- 10. VERIFY REALTIME PUBLICATION
-- ============================================

-- Ensure realtime is enabled for key tables
DO $$
BEGIN
  -- Add to realtime if not already there
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'sync_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_runs;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'merge_conflicts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.merge_conflicts;
  END IF;
END $$;

-- ============================================
-- 11. COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON TABLE public.clients IS 'Unified customer master table with cross-platform identity mapping';
COMMENT ON TABLE public.sync_runs IS 'Tracks all synchronization operations from external sources';
COMMENT ON TABLE public.merge_conflicts IS 'Stores conflicts when merging contacts from different sources';
COMMENT ON TABLE public.contact_identities IS 'Identity map linking external IDs to unified client records';
COMMENT ON FUNCTION public.is_admin() IS 'Security function to check if current user is admin';
COMMENT ON FUNCTION public.normalize_email(text) IS 'Normalizes email to lowercase trimmed format';
COMMENT ON FUNCTION public.normalize_phone_e164(text) IS 'Normalizes phone numbers to E.164 format';

-- ============================================
-- 12. ANALYZE TABLES FOR QUERY OPTIMIZATION
-- ============================================

ANALYZE public.clients;
ANALYZE public.sync_runs;
ANALYZE public.merge_conflicts;
ANALYZE public.contact_identities;
ANALYZE public.transactions;
ANALYZE public.invoices;
ANALYZE public.subscriptions;
