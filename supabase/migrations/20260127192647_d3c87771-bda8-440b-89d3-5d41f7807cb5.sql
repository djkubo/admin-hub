-- =====================================================
-- PASO 1: Eliminar índices únicos duplicados en clients
-- Mantener solo un índice único por columna de identidad
-- =====================================================

-- Email: mantener solo idx_clients_email_unique (usa lower() para normalización)
DROP INDEX IF EXISTS clients_email_key;
DROP INDEX IF EXISTS clients_email_unique;

-- ManyChat: mantener solo idx_clients_manychat_id
DROP INDEX IF EXISTS idx_clients_manychat_unique;

-- GHL: mantener solo idx_clients_ghl_id  
DROP INDEX IF EXISTS idx_clients_ghl_unique;

-- PayPal: verificar y limpiar si hay duplicados
DROP INDEX IF EXISTS idx_clients_paypal_unique;

-- =====================================================
-- PASO 2: Actualizar RPC unify_identity para manejar
-- correctamente las actualizaciones sin falsos positivos
-- =====================================================

CREATE OR REPLACE FUNCTION public.unify_identity(
  p_source text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_paypal_customer_id text DEFAULT NULL,
  p_ghl_contact_id text DEFAULT NULL,
  p_manychat_subscriber_id text DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_opt_in jsonb DEFAULT NULL,
  p_tracking_data jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
BEGIN
  -- Normalize inputs
  v_email_normalized := normalize_email(p_email);
  v_phone_e164 := normalize_phone_e164(p_phone);
  
  -- Parse opt-in flags
  v_wa_opt_in := COALESCE((p_opt_in->>'wa_opt_in')::boolean, false);
  v_sms_opt_in := COALESCE((p_opt_in->>'sms_opt_in')::boolean, false);
  v_email_opt_in := COALESCE((p_opt_in->>'email_opt_in')::boolean, true);

  -- =====================================================
  -- BÚSQUEDA DE CLIENTE EXISTENTE (orden de prioridad)
  -- =====================================================
  
  -- 1. Buscar por ID externo específico de la fuente
  IF p_source = 'stripe' AND p_stripe_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients 
    WHERE stripe_customer_id = p_stripe_customer_id LIMIT 1;
    IF v_existing_client.id IS NOT NULL THEN
      v_match_by := 'stripe_customer_id';
    END IF;
  ELSIF p_source = 'paypal' AND p_paypal_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients 
    WHERE paypal_customer_id = p_paypal_customer_id LIMIT 1;
    IF v_existing_client.id IS NOT NULL THEN
      v_match_by := 'paypal_customer_id';
    END IF;
  ELSIF p_source = 'ghl' AND p_ghl_contact_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients 
    WHERE ghl_contact_id = p_ghl_contact_id LIMIT 1;
    IF v_existing_client.id IS NOT NULL THEN
      v_match_by := 'ghl_contact_id';
    END IF;
  ELSIF p_source = 'manychat' AND p_manychat_subscriber_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients 
    WHERE manychat_subscriber_id = p_manychat_subscriber_id LIMIT 1;
    IF v_existing_client.id IS NOT NULL THEN
      v_match_by := 'manychat_subscriber_id';
    END IF;
  END IF;
  
  -- 2. Si no encontramos por ID externo, buscar por email normalizado
  IF v_existing_client.id IS NULL AND v_email_normalized IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients 
    WHERE lower(trim(email)) = v_email_normalized LIMIT 1;
    IF v_existing_client.id IS NOT NULL THEN
      v_match_by := 'email';
    END IF;
  END IF;
  
  -- 3. Si no hay match por email, buscar por teléfono
  IF v_existing_client.id IS NULL AND v_phone_e164 IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients 
    WHERE phone_e164 = v_phone_e164 OR phone = v_phone_e164 LIMIT 1;
    IF v_existing_client.id IS NOT NULL THEN
      v_match_by := 'phone';
    END IF;
  END IF;

  -- =====================================================
  -- CREAR O ACTUALIZAR CLIENTE
  -- =====================================================
  
  IF v_existing_client.id IS NOT NULL THEN
    -- ACTUALIZAR cliente existente
    v_client_id := v_existing_client.id;
    v_action := 'updated';
    
    UPDATE clients SET
      -- Email: solo actualizar si viene valor y el actual es NULL
      email = COALESCE(
        CASE WHEN v_email_normalized IS NOT NULL AND email IS NULL THEN v_email_normalized ELSE NULL END,
        email
      ),
      -- Phone: priorizar fuentes más confiables
      phone = CASE 
        WHEN p_source IN ('stripe', 'paypal', 'web') AND v_phone_e164 IS NOT NULL THEN v_phone_e164
        WHEN phone IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164
        ELSE phone
      END,
      phone_e164 = CASE 
        WHEN p_source IN ('stripe', 'paypal', 'web') AND v_phone_e164 IS NOT NULL THEN v_phone_e164
        WHEN phone_e164 IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164
        ELSE phone_e164
      END,
      -- Name: preferir nombres más largos/completos
      full_name = CASE
        WHEN p_full_name IS NOT NULL AND p_full_name != '' AND (
          full_name IS NULL OR 
          length(trim(p_full_name)) > length(trim(COALESCE(full_name, '')))
        ) THEN trim(p_full_name)
        ELSE full_name
      END,
      -- External IDs: actualizar solo si viene valor nuevo
      stripe_customer_id = COALESCE(
        CASE WHEN p_stripe_customer_id IS NOT NULL THEN p_stripe_customer_id ELSE NULL END,
        stripe_customer_id
      ),
      paypal_customer_id = COALESCE(
        CASE WHEN p_paypal_customer_id IS NOT NULL THEN p_paypal_customer_id ELSE NULL END,
        paypal_customer_id
      ),
      ghl_contact_id = COALESCE(
        CASE WHEN p_ghl_contact_id IS NOT NULL THEN p_ghl_contact_id ELSE NULL END,
        ghl_contact_id
      ),
      manychat_subscriber_id = COALESCE(
        CASE WHEN p_manychat_subscriber_id IS NOT NULL THEN p_manychat_subscriber_id ELSE NULL END,
        manychat_subscriber_id
      ),
      -- Tags: merge sin duplicados
      tags = ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || COALESCE(p_tags, '{}'))),
      -- Opt-in: solo activar, nunca desactivar
      wa_opt_in = CASE WHEN v_wa_opt_in THEN true ELSE wa_opt_in END,
      sms_opt_in = CASE WHEN v_sms_opt_in THEN true ELSE sms_opt_in END,
      email_opt_in = CASE WHEN v_email_opt_in THEN true ELSE email_opt_in END,
      -- Tracking data: merge con existente
      tracking_data = CASE 
        WHEN p_tracking_data IS NOT NULL THEN 
          COALESCE(tracking_data, '{}'::jsonb) || p_tracking_data
        ELSE tracking_data
      END,
      -- UTM fields: actualizar solo si vienen y son más recientes
      utm_source = COALESCE(p_tracking_data->>'utm_source', utm_source),
      utm_medium = COALESCE(p_tracking_data->>'utm_medium', utm_medium),
      utm_campaign = COALESCE(p_tracking_data->>'utm_campaign', utm_campaign),
      utm_content = COALESCE(p_tracking_data->>'utm_content', utm_content),
      utm_term = COALESCE(p_tracking_data->>'utm_term', utm_term),
      -- Timestamps
      last_sync = now(),
      last_attribution_at = CASE 
        WHEN p_tracking_data IS NOT NULL AND p_tracking_data->>'utm_source' IS NOT NULL 
        THEN now() 
        ELSE last_attribution_at 
      END
    WHERE id = v_client_id;
    
  ELSE
    -- CREAR nuevo cliente
    v_action := 'created';
    
    INSERT INTO clients (
      email,
      phone,
      phone_e164,
      full_name,
      stripe_customer_id,
      paypal_customer_id,
      ghl_contact_id,
      manychat_subscriber_id,
      tags,
      wa_opt_in,
      sms_opt_in,
      email_opt_in,
      tracking_data,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      lifecycle_stage,
      acquisition_source,
      acquisition_medium,
      acquisition_campaign,
      acquisition_content,
      first_seen_at,
      last_sync
    ) VALUES (
      v_email_normalized,
      v_phone_e164,
      v_phone_e164,
      trim(p_full_name),
      p_stripe_customer_id,
      p_paypal_customer_id,
      p_ghl_contact_id,
      p_manychat_subscriber_id,
      COALESCE(p_tags, '{}'),
      COALESCE(v_wa_opt_in, false),
      COALESCE(v_sms_opt_in, false),
      COALESCE(v_email_opt_in, true),
      p_tracking_data,
      p_tracking_data->>'utm_source',
      p_tracking_data->>'utm_medium',
      p_tracking_data->>'utm_campaign',
      p_tracking_data->>'utm_content',
      p_tracking_data->>'utm_term',
      'LEAD',
      COALESCE(p_tracking_data->>'utm_source', p_source),
      p_tracking_data->>'utm_medium',
      p_tracking_data->>'utm_campaign',
      p_tracking_data->>'utm_content',
      now(),
      now()
    )
    RETURNING id INTO v_client_id;
  END IF;

  -- =====================================================
  -- CREAR/ACTUALIZAR IDENTITY MAPPING
  -- =====================================================
  
  -- Solo crear identity si tenemos un external_id
  IF p_stripe_customer_id IS NOT NULL OR p_paypal_customer_id IS NOT NULL 
     OR p_ghl_contact_id IS NOT NULL OR p_manychat_subscriber_id IS NOT NULL THEN
    
    INSERT INTO contact_identities (
      source,
      external_id,
      client_id,
      email_normalized,
      phone_e164,
      created_at,
      updated_at
    ) VALUES (
      p_source,
      COALESCE(
        p_stripe_customer_id, 
        p_paypal_customer_id, 
        p_ghl_contact_id, 
        p_manychat_subscriber_id
      ),
      v_client_id,
      v_email_normalized,
      v_phone_e164,
      now(),
      now()
    )
    ON CONFLICT (source, external_id) 
    DO UPDATE SET
      client_id = EXCLUDED.client_id,
      email_normalized = COALESCE(EXCLUDED.email_normalized, contact_identities.email_normalized),
      phone_e164 = COALESCE(EXCLUDED.phone_e164, contact_identities.phone_e164),
      updated_at = now();
  END IF;

  -- =====================================================
  -- RETORNAR RESULTADO
  -- =====================================================
  
  RETURN jsonb_build_object(
    'success', true,
    'client_id', v_client_id,
    'action', v_action,
    'match_by', v_match_by,
    'source', p_source
  );

EXCEPTION 
  WHEN unique_violation THEN
    -- Solo para INSERTs fallidos, los UPDATEs no deberían llegar aquí
    IF v_action = 'created' OR v_action = 'none' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'DUPLICATE_IDENTITY',
        'message', 'A client with this identity already exists. Try searching first.',
        'source', p_source,
        'email', v_email_normalized,
        'phone', v_phone_e164
      );
    ELSE
      -- Para updates con conflicto, retornar éxito parcial
      RETURN jsonb_build_object(
        'success', true,
        'client_id', v_client_id,
        'action', 'updated_partial',
        'warning', 'Some fields could not be updated due to uniqueness constraints',
        'source', p_source
      );
    END IF;
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'sqlstate', SQLSTATE,
      'source', p_source
    );
END;
$$;