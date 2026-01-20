-- Add external IDs and consent fields to clients
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS ghl_contact_id text,
ADD COLUMN IF NOT EXISTS manychat_subscriber_id text,
ADD COLUMN IF NOT EXISTS wa_opt_in boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS sms_opt_in boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS email_opt_in boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS review_reason text;

-- Create unique indexes for external IDs
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_ghl_id ON public.clients(ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_manychat_id ON public.clients(manychat_subscriber_id) WHERE manychat_subscriber_id IS NOT NULL;

-- GHL Contacts Raw (staging)
CREATE TABLE IF NOT EXISTS public.ghl_contacts_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  sync_run_id uuid,
  UNIQUE(external_id, fetched_at)
);

ALTER TABLE public.ghl_contacts_raw ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage ghl_contacts_raw" ON public.ghl_contacts_raw
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- ManyChat Contacts Raw (staging)
CREATE TABLE IF NOT EXISTS public.manychat_contacts_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  sync_run_id uuid,
  UNIQUE(subscriber_id, fetched_at)
);

ALTER TABLE public.manychat_contacts_raw ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage manychat_contacts_raw" ON public.manychat_contacts_raw
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Contact Identities (identity map)
CREATE TABLE IF NOT EXISTS public.contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL, -- 'ghl', 'manychat', 'stripe', 'paypal', 'web', 'csv'
  external_id text NOT NULL,
  email_normalized text,
  phone_e164 text,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, external_id)
);

ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage contact_identities" ON public.contact_identities
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

CREATE INDEX idx_contact_identities_email ON public.contact_identities(email_normalized);
CREATE INDEX idx_contact_identities_phone ON public.contact_identities(phone_e164);
CREATE INDEX idx_contact_identities_client ON public.contact_identities(client_id);

-- Sync Runs (audit log)
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  status text NOT NULL DEFAULT 'running', -- running, completed, failed, partial
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  total_fetched integer DEFAULT 0,
  total_inserted integer DEFAULT 0,
  total_updated integer DEFAULT 0,
  total_skipped integer DEFAULT 0,
  total_conflicts integer DEFAULT 0,
  checkpoint jsonb DEFAULT '{}',
  error_message text,
  dry_run boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'
);

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage sync_runs" ON public.sync_runs
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Merge Conflicts (needs review)
CREATE TABLE IF NOT EXISTS public.merge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text NOT NULL,
  email_found text,
  phone_found text,
  conflict_type text NOT NULL, -- 'phone_only', 'email_mismatch', 'duplicate_candidate'
  raw_data jsonb NOT NULL,
  suggested_client_id uuid REFERENCES public.clients(id),
  status text NOT NULL DEFAULT 'pending', -- pending, resolved, ignored
  resolution text,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sync_run_id uuid REFERENCES public.sync_runs(id)
);

ALTER TABLE public.merge_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage merge_conflicts" ON public.merge_conflicts
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Helper function to normalize email
CREATE OR REPLACE FUNCTION normalize_email(email text)
RETURNS text AS $$
BEGIN
  IF email IS NULL OR email = '' THEN
    RETURN NULL;
  END IF;
  RETURN lower(trim(email));
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- Helper function to normalize phone to E.164
CREATE OR REPLACE FUNCTION normalize_phone_e164(phone text)
RETURNS text AS $$
DECLARE
  cleaned text;
BEGIN
  IF phone IS NULL OR phone = '' THEN
    RETURN NULL;
  END IF;
  
  -- Remove all non-digit characters except leading +
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
    RETURN NULL; -- Invalid phone, return null
  END IF;
  
  RETURN cleaned;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- Merge contacts function
CREATE OR REPLACE FUNCTION merge_contact(
  p_source text,
  p_external_id text,
  p_email text,
  p_phone text,
  p_full_name text,
  p_tags text[],
  p_wa_opt_in boolean,
  p_sms_opt_in boolean,
  p_email_opt_in boolean,
  p_extra_data jsonb DEFAULT '{}',
  p_dry_run boolean DEFAULT false,
  p_sync_run_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_email_normalized text;
  v_phone_e164 text;
  v_existing_client_id uuid;
  v_existing_identity_id uuid;
  v_action text := 'none';
  v_conflict_type text;
  v_result jsonb;
BEGIN
  -- Normalize inputs
  v_email_normalized := normalize_email(p_email);
  v_phone_e164 := normalize_phone_e164(p_phone);
  
  -- Check if identity already exists (idempotency)
  SELECT id, client_id INTO v_existing_identity_id, v_existing_client_id
  FROM public.contact_identities
  WHERE source = p_source AND external_id = p_external_id;
  
  IF v_existing_identity_id IS NOT NULL AND v_existing_client_id IS NOT NULL THEN
    -- Already mapped, just update if needed
    IF NOT p_dry_run THEN
      -- Update client with non-empty values using source priorities
      UPDATE public.clients SET
        phone = CASE 
          WHEN p_source IN ('web', 'csv') AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          WHEN phone IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          ELSE phone
        END,
        full_name = CASE
          WHEN p_source IN ('ghl', 'manychat') AND p_full_name IS NOT NULL AND p_full_name != '' 
               AND (full_name IS NULL OR length(p_full_name) > length(full_name)) THEN p_full_name
          WHEN full_name IS NULL AND p_full_name IS NOT NULL THEN p_full_name
          ELSE full_name
        END,
        tags = ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || COALESCE(p_tags, '{}'))),
        wa_opt_in = COALESCE(p_wa_opt_in, wa_opt_in),
        sms_opt_in = COALESCE(p_sms_opt_in, sms_opt_in),
        email_opt_in = COALESCE(p_email_opt_in, email_opt_in),
        ghl_contact_id = CASE WHEN p_source = 'ghl' THEN p_external_id ELSE ghl_contact_id END,
        manychat_subscriber_id = CASE WHEN p_source = 'manychat' THEN p_external_id ELSE manychat_subscriber_id END,
        last_sync = now()
      WHERE id = v_existing_client_id;
      
      -- Update identity
      UPDATE public.contact_identities SET
        email_normalized = COALESCE(v_email_normalized, email_normalized),
        phone_e164 = COALESCE(v_phone_e164, phone_e164),
        updated_at = now()
      WHERE id = v_existing_identity_id;
    END IF;
    
    RETURN jsonb_build_object('action', 'updated', 'client_id', v_existing_client_id);
  END IF;
  
  -- Try to find existing client by email
  IF v_email_normalized IS NOT NULL THEN
    SELECT id INTO v_existing_client_id
    FROM public.clients
    WHERE normalize_email(email) = v_email_normalized
    LIMIT 1;
  END IF;
  
  -- If no email match and only phone, create conflict for review
  IF v_existing_client_id IS NULL AND v_email_normalized IS NULL AND v_phone_e164 IS NOT NULL THEN
    IF NOT p_dry_run THEN
      INSERT INTO public.merge_conflicts (
        source, external_id, phone_found, conflict_type, raw_data, status, sync_run_id
      ) VALUES (
        p_source, p_external_id, v_phone_e164, 'phone_only', 
        p_extra_data || jsonb_build_object('name', p_full_name, 'tags', p_tags),
        'pending', p_sync_run_id
      ) ON CONFLICT DO NOTHING;
    END IF;
    
    RETURN jsonb_build_object('action', 'conflict', 'reason', 'phone_only');
  END IF;
  
  -- If still no match but we have email, create new client
  IF v_existing_client_id IS NULL AND v_email_normalized IS NOT NULL THEN
    IF NOT p_dry_run THEN
      INSERT INTO public.clients (
        email, phone, full_name, tags, wa_opt_in, sms_opt_in, email_opt_in,
        ghl_contact_id, manychat_subscriber_id, lifecycle_stage, last_sync
      ) VALUES (
        v_email_normalized, v_phone_e164, p_full_name, COALESCE(p_tags, '{}'),
        COALESCE(p_wa_opt_in, false), COALESCE(p_sms_opt_in, false), COALESCE(p_email_opt_in, true),
        CASE WHEN p_source = 'ghl' THEN p_external_id ELSE NULL END,
        CASE WHEN p_source = 'manychat' THEN p_external_id ELSE NULL END,
        'LEAD', now()
      ) RETURNING id INTO v_existing_client_id;
    END IF;
    v_action := 'inserted';
  ELSE
    -- Update existing client
    IF NOT p_dry_run THEN
      UPDATE public.clients SET
        phone = CASE 
          WHEN p_source IN ('web', 'csv') AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          WHEN phone IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          ELSE phone
        END,
        full_name = CASE
          WHEN p_source IN ('ghl', 'manychat') AND p_full_name IS NOT NULL AND p_full_name != '' 
               AND (full_name IS NULL OR length(p_full_name) > length(full_name)) THEN p_full_name
          WHEN full_name IS NULL AND p_full_name IS NOT NULL THEN p_full_name
          ELSE full_name
        END,
        tags = ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || COALESCE(p_tags, '{}'))),
        wa_opt_in = COALESCE(p_wa_opt_in, wa_opt_in),
        sms_opt_in = COALESCE(p_sms_opt_in, sms_opt_in),
        email_opt_in = COALESCE(p_email_opt_in, email_opt_in),
        ghl_contact_id = CASE WHEN p_source = 'ghl' THEN p_external_id ELSE ghl_contact_id END,
        manychat_subscriber_id = CASE WHEN p_source = 'manychat' THEN p_external_id ELSE manychat_subscriber_id END,
        last_sync = now()
      WHERE id = v_existing_client_id;
    END IF;
    v_action := 'updated';
  END IF;
  
  -- Create/update identity mapping
  IF NOT p_dry_run AND v_existing_client_id IS NOT NULL THEN
    INSERT INTO public.contact_identities (
      source, external_id, email_normalized, phone_e164, client_id
    ) VALUES (
      p_source, p_external_id, v_email_normalized, v_phone_e164, v_existing_client_id
    ) ON CONFLICT (source, external_id) DO UPDATE SET
      email_normalized = COALESCE(EXCLUDED.email_normalized, contact_identities.email_normalized),
      phone_e164 = COALESCE(EXCLUDED.phone_e164, contact_identities.phone_e164),
      client_id = EXCLUDED.client_id,
      updated_at = now();
  END IF;
  
  RETURN jsonb_build_object('action', v_action, 'client_id', v_existing_client_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;