
-- 1. Storage bucket csv-imports
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'csv-imports',
  'csv-imports',
  false,
  52428800,
  ARRAY['text/csv','text/plain','application/csv','application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies
CREATE POLICY "Admins can upload csv-imports"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'csv-imports' AND public.is_admin());

CREATE POLICY "Admins can read csv-imports"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'csv-imports' AND public.is_admin());

CREATE POLICY "Service role full access csv-imports"
  ON storage.objects FOR ALL
  USING (bucket_id = 'csv-imports')
  WITH CHECK (bucket_id = 'csv-imports');

-- 2. Tables identity_map and identity_audit_log
CREATE TABLE IF NOT EXISTS public.identity_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_map_unique UNIQUE(platform, platform_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_map_client ON public.identity_map (client_id);
CREATE INDEX IF NOT EXISTS idx_identity_map_platform_id ON public.identity_map (platform, platform_id);
ALTER TABLE public.identity_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read identity_map" ON public.identity_map FOR SELECT USING (public.is_admin());
CREATE POLICY "Service role full access on identity_map" ON public.identity_map FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON public.identity_map TO authenticated;
GRANT ALL ON public.identity_map TO service_role;

CREATE TABLE IF NOT EXISTS public.identity_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  match_by TEXT,
  source TEXT,
  old_data JSONB,
  new_data JSONB,
  merged_from_client_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_identity_audit_log_client ON public.identity_audit_log (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_audit_log_action ON public.identity_audit_log (action, created_at DESC);
ALTER TABLE public.identity_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read identity_audit_log" ON public.identity_audit_log FOR SELECT USING (public.is_admin());
CREATE POLICY "Service role full access on identity_audit_log" ON public.identity_audit_log FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON public.identity_audit_log TO authenticated;
GRANT ALL ON public.identity_audit_log TO service_role;

-- 3. Updated unify_identity function
DROP FUNCTION IF EXISTS public.unify_identity(text,text,text,text,text,text,text,text,text[],jsonb,jsonb);

CREATE OR REPLACE FUNCTION public.unify_identity(
  p_source text,
  p_stripe_customer_id text DEFAULT NULL,
  p_paypal_customer_id text DEFAULT NULL,
  p_ghl_contact_id text DEFAULT NULL,
  p_manychat_subscriber_id text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_opt_in jsonb DEFAULT NULL,
  p_tracking_data jsonb DEFAULT NULL
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
  v_action text := 'none';
  v_existing_client record;
  v_match_by text;
  v_wa_opt_in boolean;
  v_sms_opt_in boolean;
  v_email_opt_in boolean;
  v_found boolean := false;
  v_old_data jsonb;
BEGIN
  v_email_normalized := normalize_email(p_email);
  v_phone_e164 := normalize_phone_e164(p_phone);
  
  v_wa_opt_in := COALESCE((p_opt_in->>'wa_opt_in')::boolean, false);
  v_sms_opt_in := COALESCE((p_opt_in->>'sms_opt_in')::boolean, false);
  v_email_opt_in := COALESCE((p_opt_in->>'email_opt_in')::boolean, true);

  IF p_source = 'stripe' AND p_stripe_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE stripe_customer_id = p_stripe_customer_id LIMIT 1;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'stripe_customer_id'; END IF;
  ELSIF p_source = 'paypal' AND p_paypal_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE paypal_customer_id = p_paypal_customer_id LIMIT 1;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'paypal_customer_id'; END IF;
  ELSIF p_source = 'ghl' AND p_ghl_contact_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE ghl_contact_id = p_ghl_contact_id LIMIT 1;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'ghl_contact_id'; END IF;
  ELSIF p_source = 'manychat' AND p_manychat_subscriber_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE manychat_subscriber_id = p_manychat_subscriber_id LIMIT 1;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'manychat_subscriber_id'; END IF;
  END IF;
  
  IF NOT v_found AND v_email_normalized IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE lower(trim(email)) = v_email_normalized LIMIT 1;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'email'; END IF;
  END IF;
  
  IF NOT v_found AND v_phone_e164 IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE phone_e164 = v_phone_e164 OR phone = v_phone_e164 LIMIT 1;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'phone'; END IF;
  END IF;

  IF v_found THEN
    v_client_id := v_existing_client.id;
    v_action := 'updated';
    v_old_data := jsonb_build_object(
      'email', v_existing_client.email,
      'phone', v_existing_client.phone,
      'full_name', v_existing_client.full_name,
      'stripe_customer_id', v_existing_client.stripe_customer_id,
      'paypal_customer_id', v_existing_client.paypal_customer_id,
      'ghl_contact_id', v_existing_client.ghl_contact_id,
      'manychat_subscriber_id', v_existing_client.manychat_subscriber_id
    );

    UPDATE clients SET
      full_name = COALESCE(NULLIF(p_full_name, ''), full_name),
      email = COALESCE(v_email_normalized, email),
      phone = COALESCE(NULLIF(p_phone, ''), phone),
      phone_e164 = COALESCE(v_phone_e164, phone_e164),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      paypal_customer_id = COALESCE(p_paypal_customer_id, paypal_customer_id),
      ghl_contact_id = COALESCE(p_ghl_contact_id, ghl_contact_id),
      manychat_subscriber_id = COALESCE(p_manychat_subscriber_id, manychat_subscriber_id),
      tags = COALESCE(
        CASE WHEN p_tags IS NOT NULL AND array_length(p_tags, 1) > 0 
             THEN (SELECT array_agg(DISTINCT t) FROM unnest(COALESCE(tags, ARRAY[]::text[]) || p_tags) t)
             ELSE tags END, tags),
      wa_opt_in = CASE WHEN v_wa_opt_in THEN true ELSE wa_opt_in END,
      sms_opt_in = CASE WHEN v_sms_opt_in THEN true ELSE sms_opt_in END,
      email_opt_in = CASE WHEN v_email_opt_in THEN true ELSE email_opt_in END,
      tracking_data = CASE 
        WHEN p_tracking_data IS NOT NULL THEN COALESCE(tracking_data, '{}'::jsonb) || p_tracking_data 
        ELSE tracking_data END,
      last_seen_at = now(),
      updated_at = now()
    WHERE id = v_client_id;
  ELSE
    v_action := 'created';
    INSERT INTO clients (
      email, phone, phone_e164, full_name,
      stripe_customer_id, paypal_customer_id, ghl_contact_id, manychat_subscriber_id,
      tags, wa_opt_in, sms_opt_in, email_opt_in,
      tracking_data, last_seen_at
    ) VALUES (
      v_email_normalized, p_phone, v_phone_e164, p_full_name,
      p_stripe_customer_id, p_paypal_customer_id, p_ghl_contact_id, p_manychat_subscriber_id,
      COALESCE(p_tags, ARRAY[]::text[]),
      v_wa_opt_in, v_sms_opt_in, v_email_opt_in,
      COALESCE(p_tracking_data, '{}'::jsonb), now()
    )
    RETURNING id INTO v_client_id;
    v_old_data := NULL;
  END IF;

  -- IDENTITY MAP
  IF p_stripe_customer_id IS NOT NULL THEN
    INSERT INTO identity_map (client_id, platform, platform_id)
    VALUES (v_client_id, 'stripe', p_stripe_customer_id)
    ON CONFLICT (platform, platform_id) DO UPDATE SET client_id = v_client_id;
  END IF;
  IF p_paypal_customer_id IS NOT NULL THEN
    INSERT INTO identity_map (client_id, platform, platform_id)
    VALUES (v_client_id, 'paypal', p_paypal_customer_id)
    ON CONFLICT (platform, platform_id) DO UPDATE SET client_id = v_client_id;
  END IF;
  IF p_ghl_contact_id IS NOT NULL THEN
    INSERT INTO identity_map (client_id, platform, platform_id)
    VALUES (v_client_id, 'ghl', p_ghl_contact_id)
    ON CONFLICT (platform, platform_id) DO UPDATE SET client_id = v_client_id;
  END IF;
  IF p_manychat_subscriber_id IS NOT NULL THEN
    INSERT INTO identity_map (client_id, platform, platform_id)
    VALUES (v_client_id, 'manychat', p_manychat_subscriber_id)
    ON CONFLICT (platform, platform_id) DO UPDATE SET client_id = v_client_id;
  END IF;
  IF v_email_normalized IS NOT NULL THEN
    INSERT INTO identity_map (client_id, platform, platform_id, confidence)
    VALUES (v_client_id, 'email', v_email_normalized, 0.95)
    ON CONFLICT (platform, platform_id) DO UPDATE SET client_id = v_client_id;
  END IF;
  IF v_phone_e164 IS NOT NULL THEN
    INSERT INTO identity_map (client_id, platform, platform_id, confidence)
    VALUES (v_client_id, 'phone', v_phone_e164, 0.90)
    ON CONFLICT (platform, platform_id) DO UPDATE SET client_id = v_client_id;
  END IF;

  -- AUDIT LOG
  INSERT INTO identity_audit_log (
    client_id, action, match_by, source, old_data, new_data
  ) VALUES (
    v_client_id, v_action, v_match_by, p_source, v_old_data,
    jsonb_build_object(
      'email', v_email_normalized,
      'phone', p_phone,
      'full_name', p_full_name,
      'stripe_customer_id', p_stripe_customer_id,
      'paypal_customer_id', p_paypal_customer_id,
      'ghl_contact_id', p_ghl_contact_id,
      'manychat_subscriber_id', p_manychat_subscriber_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'client_id', v_client_id,
    'action', v_action,
    'match_by', COALESCE(v_match_by, 'none')
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
