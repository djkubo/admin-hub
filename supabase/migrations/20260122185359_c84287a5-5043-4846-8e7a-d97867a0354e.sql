-- ==========================================
-- CROSS-PLATFORM IDENTITY UNIFICATION SCHEMA
-- ==========================================

-- 1. Add phone_e164 normalized column
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS phone_e164 text;

-- 2. Add JSONB for flexible marketing/tracking data
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS tracking_data jsonb DEFAULT '{}'::jsonb;

-- 3. Add last_attribution_date for tracking recency
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS last_attribution_at timestamptz;

-- 4. Add PayPal customer ID for completeness
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS paypal_customer_id text;

-- 5. Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_clients_phone_e164 
ON public.clients (phone_e164) 
WHERE phone_e164 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_paypal_id 
ON public.clients (paypal_customer_id) 
WHERE paypal_customer_id IS NOT NULL;

-- 6. GIN index for JSONB tracking_data searches
CREATE INDEX IF NOT EXISTS idx_clients_tracking_data 
ON public.clients USING gin (tracking_data);

-- 7. Populate phone_e164 from existing phone data
UPDATE public.clients 
SET phone_e164 = normalize_phone_e164(phone)
WHERE phone IS NOT NULL 
  AND phone_e164 IS NULL;

-- ==========================================
-- UPSERT FUNCTION: unify_identity
-- ==========================================
-- This function implements "God-Level Matching" logic:
-- A) Email as master key
-- B) Merge/update if exists, insert if new
-- C) Priority: NEWER data wins for tracking, EXISTING data preserved for core fields

CREATE OR REPLACE FUNCTION public.unify_identity(
  p_source text,                    -- 'manychat' | 'ghl' | 'stripe' | 'paypal' | 'web'
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_ghl_contact_id text DEFAULT NULL,
  p_manychat_subscriber_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_paypal_customer_id text DEFAULT NULL,
  p_tracking_data jsonb DEFAULT '{}'::jsonb,
  p_tags text[] DEFAULT '{}'::text[],
  p_opt_in jsonb DEFAULT '{}'::jsonb  -- {"wa": true, "sms": false, "email": true}
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_email_normalized text;
  v_phone_e164 text;
  v_client_id uuid;
  v_existing record;
  v_action text := 'none';
  v_merged_tracking jsonb;
  v_merged_tags text[];
  v_changes jsonb := '{}'::jsonb;
BEGIN
  -- ==========================================
  -- STEP 1: NORMALIZE INPUTS
  -- ==========================================
  v_email_normalized := normalize_email(p_email);
  v_phone_e164 := normalize_phone_e164(p_phone);
  
  -- Must have at least email or phone
  IF v_email_normalized IS NULL AND v_phone_e164 IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'EMAIL_OR_PHONE_REQUIRED',
      'message', 'Must provide valid email or phone'
    );
  END IF;

  -- ==========================================
  -- STEP 2: SEARCH (Email as Master Key)
  -- ==========================================
  -- Priority order: Email > GHL ID > ManyChat ID > Stripe ID > PayPal ID > Phone
  
  IF v_email_normalized IS NOT NULL THEN
    SELECT * INTO v_existing 
    FROM public.clients 
    WHERE normalize_email(email) = v_email_normalized
    LIMIT 1;
  END IF;
  
  IF v_existing IS NULL AND p_ghl_contact_id IS NOT NULL THEN
    SELECT * INTO v_existing 
    FROM public.clients 
    WHERE ghl_contact_id = p_ghl_contact_id
    LIMIT 1;
  END IF;
  
  IF v_existing IS NULL AND p_manychat_subscriber_id IS NOT NULL THEN
    SELECT * INTO v_existing 
    FROM public.clients 
    WHERE manychat_subscriber_id = p_manychat_subscriber_id
    LIMIT 1;
  END IF;
  
  IF v_existing IS NULL AND p_stripe_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing 
    FROM public.clients 
    WHERE stripe_customer_id = p_stripe_customer_id
    LIMIT 1;
  END IF;
  
  IF v_existing IS NULL AND p_paypal_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing 
    FROM public.clients 
    WHERE paypal_customer_id = p_paypal_customer_id
    LIMIT 1;
  END IF;
  
  IF v_existing IS NULL AND v_phone_e164 IS NOT NULL THEN
    SELECT * INTO v_existing 
    FROM public.clients 
    WHERE phone_e164 = v_phone_e164
    LIMIT 1;
  END IF;

  -- ==========================================
  -- STEP 3A: UPDATE EXISTING CLIENT
  -- ==========================================
  IF v_existing IS NOT NULL THEN
    v_client_id := v_existing.id;
    v_action := 'updated';
    
    -- MERGE TRACKING DATA (newer wins, but preserve history)
    -- tracking_data structure: {fbp, fbc, gclid, utm_*, history: [{...}, {...}]}
    v_merged_tracking := COALESCE(v_existing.tracking_data, '{}'::jsonb);
    
    -- Add previous tracking to history before overwriting
    IF v_merged_tracking != '{}'::jsonb AND p_tracking_data != '{}'::jsonb THEN
      v_merged_tracking := jsonb_set(
        v_merged_tracking,
        '{history}',
        COALESCE(v_merged_tracking->'history', '[]'::jsonb) || 
        jsonb_build_array(
          jsonb_build_object(
            'captured_at', v_existing.last_attribution_at,
            'source', v_existing.acquisition_source,
            'data', v_existing.tracking_data - 'history'
          )
        )
      );
    END IF;
    
    -- Apply new tracking data (overwrite top-level keys)
    IF p_tracking_data != '{}'::jsonb THEN
      v_merged_tracking := v_merged_tracking || p_tracking_data;
    END IF;
    
    -- MERGE TAGS (union)
    v_merged_tags := ARRAY(
      SELECT DISTINCT unnest(
        COALESCE(v_existing.tags, '{}') || COALESCE(p_tags, '{}')
      )
    );
    
    -- BUILD CHANGES RECORD
    v_changes := jsonb_build_object('fields_updated', '[]'::jsonb);
    
    -- UPDATE with priority rules
    UPDATE public.clients SET
      -- Core identity: Fill if empty, don't overwrite
      email = CASE 
        WHEN email IS NULL AND v_email_normalized IS NOT NULL THEN v_email_normalized 
        ELSE email 
      END,
      phone = CASE 
        WHEN phone IS NULL AND p_phone IS NOT NULL THEN p_phone 
        ELSE phone 
      END,
      phone_e164 = CASE 
        WHEN phone_e164 IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164 
        ELSE phone_e164 
      END,
      full_name = CASE 
        WHEN full_name IS NULL AND p_full_name IS NOT NULL THEN p_full_name 
        WHEN p_full_name IS NOT NULL AND length(p_full_name) > length(COALESCE(full_name, '')) THEN p_full_name
        ELSE full_name 
      END,
      
      -- Platform IDs: Fill if empty
      ghl_contact_id = COALESCE(ghl_contact_id, p_ghl_contact_id),
      manychat_subscriber_id = COALESCE(manychat_subscriber_id, p_manychat_subscriber_id),
      stripe_customer_id = COALESCE(stripe_customer_id, p_stripe_customer_id),
      paypal_customer_id = COALESCE(paypal_customer_id, p_paypal_customer_id),
      
      -- Attribution: Keep original source, update tracking
      acquisition_source = COALESCE(acquisition_source, p_source),
      tracking_data = v_merged_tracking,
      last_attribution_at = CASE WHEN p_tracking_data != '{}'::jsonb THEN now() ELSE last_attribution_at END,
      
      -- UTM: NEWER data wins
      utm_source = COALESCE((p_tracking_data->>'utm_source'), utm_source),
      utm_medium = COALESCE((p_tracking_data->>'utm_medium'), utm_medium),
      utm_campaign = COALESCE((p_tracking_data->>'utm_campaign'), utm_campaign),
      utm_content = COALESCE((p_tracking_data->>'utm_content'), utm_content),
      utm_term = COALESCE((p_tracking_data->>'utm_term'), utm_term),
      
      -- Tags: Merge
      tags = v_merged_tags,
      
      -- Opt-ins: Only upgrade (false -> true), never downgrade
      wa_opt_in = CASE 
        WHEN (p_opt_in->>'wa')::boolean = true THEN true 
        ELSE wa_opt_in 
      END,
      sms_opt_in = CASE 
        WHEN (p_opt_in->>'sms')::boolean = true THEN true 
        ELSE sms_opt_in 
      END,
      email_opt_in = CASE 
        WHEN (p_opt_in->>'email')::boolean = true THEN true 
        ELSE email_opt_in 
      END,
      
      -- Timestamps
      last_sync = now(),
      last_lead_at = now()
    WHERE id = v_client_id;
    
  -- ==========================================
  -- STEP 3B: INSERT NEW CLIENT
  -- ==========================================
  ELSE
    v_action := 'created';
    
    INSERT INTO public.clients (
      email, phone, phone_e164, full_name,
      ghl_contact_id, manychat_subscriber_id, stripe_customer_id, paypal_customer_id,
      lifecycle_stage, lead_status, status,
      acquisition_source, tracking_data, last_attribution_at,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      tags, wa_opt_in, sms_opt_in, email_opt_in,
      first_seen_at, last_sync, last_lead_at
    ) VALUES (
      v_email_normalized, p_phone, v_phone_e164, p_full_name,
      p_ghl_contact_id, p_manychat_subscriber_id, p_stripe_customer_id, p_paypal_customer_id,
      'LEAD', 'lead', 'active',
      p_source, p_tracking_data, CASE WHEN p_tracking_data != '{}'::jsonb THEN now() ELSE NULL END,
      p_tracking_data->>'utm_source', p_tracking_data->>'utm_medium', 
      p_tracking_data->>'utm_campaign', p_tracking_data->>'utm_content', p_tracking_data->>'utm_term',
      COALESCE(p_tags, '{}'),
      COALESCE((p_opt_in->>'wa')::boolean, false),
      COALESCE((p_opt_in->>'sms')::boolean, false),
      COALESCE((p_opt_in->>'email')::boolean, true),
      now(), now(), now()
    )
    RETURNING id INTO v_client_id;
  END IF;

  -- ==========================================
  -- STEP 4: RETURN RESULT
  -- ==========================================
  RETURN jsonb_build_object(
    'success', true,
    'action', v_action,
    'client_id', v_client_id,
    'source', p_source,
    'email_matched', v_email_normalized IS NOT NULL,
    'phone_matched', v_phone_e164 IS NOT NULL
  );
  
EXCEPTION WHEN unique_violation THEN
  -- Handle race condition on unique constraints
  RETURN jsonb_build_object(
    'success', false,
    'error', 'DUPLICATE_IDENTITY',
    'message', 'A client with this identity already exists'
  );
END;
$$;