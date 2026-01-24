-- ============================================
-- RECEIVE-LEAD OPTIMIZATION: Indexes & Constraints
-- ============================================

-- 1. Ensure customer_metadata column exists with JSONB default
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'clients' 
    AND column_name = 'customer_metadata'
  ) THEN
    ALTER TABLE public.clients ADD COLUMN customer_metadata JSONB DEFAULT '{}';
  END IF;
END $$;

-- 2. Unique partial index on manychat_subscriber_id (when not null)
-- This prevents duplicate ManyChat IDs
DROP INDEX IF EXISTS idx_clients_manychat_unique;
CREATE UNIQUE INDEX idx_clients_manychat_unique 
ON public.clients (manychat_subscriber_id) 
WHERE manychat_subscriber_id IS NOT NULL;

-- 3. Unique partial index on email (when not null)
-- This prevents duplicate emails
DROP INDEX IF EXISTS idx_clients_email_unique;
CREATE UNIQUE INDEX idx_clients_email_unique 
ON public.clients (LOWER(email)) 
WHERE email IS NOT NULL;

-- 4. Unique partial index on ghl_contact_id (when not null)
DROP INDEX IF EXISTS idx_clients_ghl_unique;
CREATE UNIQUE INDEX idx_clients_ghl_unique 
ON public.clients (ghl_contact_id) 
WHERE ghl_contact_id IS NOT NULL;

-- 5. Index on phone_e164 for quick lookups
CREATE INDEX IF NOT EXISTS idx_clients_phone_e164 ON public.clients (phone_e164);

-- 6. GIN index on customer_metadata for JSONB queries
CREATE INDEX IF NOT EXISTS idx_clients_metadata_gin 
ON public.clients USING GIN (customer_metadata);

-- 7. Index on last_lead_at for recent leads queries
CREATE INDEX IF NOT EXISTS idx_clients_last_lead_at 
ON public.clients (last_lead_at DESC NULLS LAST);