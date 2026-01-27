-- Primero eliminar la función existente para poder recrearla con nuevos parámetros
DROP FUNCTION IF EXISTS public.unify_identity(text,text,text,text,text,text,text,text,text[],jsonb,jsonb);

-- Recrear con el fix de v_found
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
      tracking_data = CASE WHEN p_tracking_data IS NOT NULL THEN COALESCE(tracking_data, '{}'::jsonb) || p_tracking_data ELSE tracking_data END,
      last_sync = now()
    WHERE id = v_client_id;
  ELSE
    v_action := 'created';
    INSERT INTO clients (full_name, email, phone, phone_e164, stripe_customer_id, paypal_customer_id, ghl_contact_id, manychat_subscriber_id, tags, wa_opt_in, sms_opt_in, email_opt_in, tracking_data, lifecycle_stage, created_at, last_sync)
    VALUES (NULLIF(p_full_name, ''), v_email_normalized, NULLIF(p_phone, ''), v_phone_e164, p_stripe_customer_id, p_paypal_customer_id, p_ghl_contact_id, p_manychat_subscriber_id, p_tags, v_wa_opt_in, v_sms_opt_in, v_email_opt_in, p_tracking_data, 'LEAD', now(), now())
    RETURNING id INTO v_client_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'client_id', v_client_id, 'action', v_action, 'match_by', v_match_by);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- También fix para unify_identity_v2
DROP FUNCTION IF EXISTS public.unify_identity_v2(text,text,text,text,text,text,jsonb);

CREATE OR REPLACE FUNCTION public.unify_identity_v2(
  p_source text,
  p_ghl_contact_id text DEFAULT NULL,
  p_manychat_subscriber_id text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
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
  v_found boolean := false;
BEGIN
  v_email_normalized := normalize_email(p_email);
  v_phone_e164 := normalize_phone_e164(p_phone);

  IF p_source = 'ghl' AND p_ghl_contact_id IS NOT NULL THEN
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
    UPDATE clients SET
      full_name = COALESCE(NULLIF(p_full_name, ''), full_name),
      email = COALESCE(v_email_normalized, email),
      phone = COALESCE(NULLIF(p_phone, ''), phone),
      phone_e164 = COALESCE(v_phone_e164, phone_e164),
      ghl_contact_id = COALESCE(p_ghl_contact_id, ghl_contact_id),
      manychat_subscriber_id = COALESCE(p_manychat_subscriber_id, manychat_subscriber_id),
      tracking_data = CASE WHEN p_tracking_data IS NOT NULL THEN COALESCE(tracking_data, '{}'::jsonb) || p_tracking_data ELSE tracking_data END,
      last_sync = now()
    WHERE id = v_client_id;
  ELSE
    v_action := 'created';
    INSERT INTO clients (full_name, email, phone, phone_e164, ghl_contact_id, manychat_subscriber_id, tracking_data, lifecycle_stage, created_at, last_sync)
    VALUES (NULLIF(p_full_name, ''), v_email_normalized, NULLIF(p_phone, ''), v_phone_e164, p_ghl_contact_id, p_manychat_subscriber_id, p_tracking_data, 'LEAD', now(), now())
    RETURNING id INTO v_client_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'client_id', v_client_id, 'action', v_action, 'match_by', v_match_by);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION public.unify_identity TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unify_identity_v2 TO anon, authenticated, service_role;

-- Recargar caché
NOTIFY pgrst, 'reload schema';