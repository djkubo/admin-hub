-- Fix merge_contact() to stop generating endless phone-only merge_conflicts.
--
-- Observed symptom: merge_conflicts had massive duplicates for the same (source, external_id,
-- conflict_type) because merge_contact() inserted a new row on every re-fetch when email was null.
--
-- This migration:
-- 1) Deduplicates existing pending merge_conflicts (keeps the earliest row per key).
-- 2) Adds a unique partial index to prevent duplicate pending conflicts going forward.
-- 3) Updates merge_contact() so phone-only contacts are matched/inserted by phone, and a conflict is
--    created only when the phone matches multiple clients.

-- 1) Deduplicate pending conflicts (keep the earliest row per key).
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY source, external_id, conflict_type
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.merge_conflicts
  WHERE status = 'pending'
)
DELETE FROM public.merge_conflicts mc
USING ranked r
WHERE mc.id = r.id
  AND r.rn > 1;

-- 2) Prevent future duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_conflicts_unique_pending
  ON public.merge_conflicts (source, external_id, conflict_type)
  WHERE status = 'pending';

-- 3) Replace merge_contact() with phone-aware logic.
CREATE OR REPLACE FUNCTION public.merge_contact(
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
  v_phone_match_ids uuid[];
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
      UPDATE public.clients SET
        phone = CASE
          WHEN p_source IN ('web', 'csv') AND NULLIF(p_phone, '') IS NOT NULL THEN p_phone
          WHEN phone IS NULL AND NULLIF(p_phone, '') IS NOT NULL THEN p_phone
          ELSE phone
        END,
        phone_e164 = CASE
          WHEN p_source IN ('web', 'csv') AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          WHEN phone_e164 IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          ELSE phone_e164
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

      UPDATE public.contact_identities SET
        email_normalized = COALESCE(v_email_normalized, email_normalized),
        phone_e164 = COALESCE(v_phone_e164, phone_e164),
        updated_at = now()
      WHERE id = v_existing_identity_id;
    END IF;

    RETURN jsonb_build_object('action', 'updated', 'client_id', v_existing_client_id);
  END IF;

  -- Try to find existing client by email (master key)
  IF v_email_normalized IS NOT NULL THEN
    SELECT id INTO v_existing_client_id
    FROM public.clients
    WHERE normalize_email(email) = v_email_normalized
    LIMIT 1;
  END IF;

  -- Phone-only: match by phone, else insert.
  IF v_existing_client_id IS NULL AND v_email_normalized IS NULL AND v_phone_e164 IS NOT NULL THEN
    -- Fetch up to 2 ids to detect duplicates without scanning/aggregating large sets.
    SELECT array_agg(id) INTO v_phone_match_ids
    FROM (
      SELECT id FROM public.clients WHERE phone_e164 = v_phone_e164
      UNION
      SELECT id FROM public.clients WHERE phone = v_phone_e164
      LIMIT 2
    ) t;

    IF COALESCE(array_length(v_phone_match_ids, 1), 0) > 1 THEN
      -- Ambiguous: more than one client shares this phone.
      IF NOT p_dry_run THEN
        INSERT INTO public.merge_conflicts (
          source, external_id, phone_found, conflict_type, raw_data, status, sync_run_id
        ) VALUES (
          p_source, p_external_id, v_phone_e164, 'duplicate_candidate',
          p_extra_data || jsonb_build_object('name', p_full_name, 'tags', p_tags),
          'pending', p_sync_run_id
        ) ON CONFLICT (source, external_id, conflict_type) WHERE status = 'pending' DO NOTHING;
      END IF;

      RETURN jsonb_build_object('action', 'conflict', 'reason', 'duplicate_candidate');

    ELSIF COALESCE(array_length(v_phone_match_ids, 1), 0) = 1 THEN
      v_existing_client_id := v_phone_match_ids[1];
      v_action := 'updated';

    ELSE
      -- No match: create a phone-only client (lead)
      IF NOT p_dry_run THEN
        INSERT INTO public.clients (
          email, phone, phone_e164, full_name, tags,
          wa_opt_in, sms_opt_in, email_opt_in,
          ghl_contact_id, manychat_subscriber_id,
          lifecycle_stage, last_sync
        ) VALUES (
          NULL, NULLIF(p_phone, ''), v_phone_e164, p_full_name, COALESCE(p_tags, '{}'),
          COALESCE(p_wa_opt_in, false), COALESCE(p_sms_opt_in, false), COALESCE(p_email_opt_in, true),
          CASE WHEN p_source = 'ghl' THEN p_external_id ELSE NULL END,
          CASE WHEN p_source = 'manychat' THEN p_external_id ELSE NULL END,
          'LEAD', now()
        ) RETURNING id INTO v_existing_client_id;
      END IF;

      v_action := 'inserted';
    END IF;
  END IF;

  -- If still no match but we have email, create new client
  IF v_existing_client_id IS NULL AND v_email_normalized IS NOT NULL THEN
    IF NOT p_dry_run THEN
      INSERT INTO public.clients (
        email, phone, phone_e164, full_name, tags,
        wa_opt_in, sms_opt_in, email_opt_in,
        ghl_contact_id, manychat_subscriber_id,
        lifecycle_stage, last_sync
      ) VALUES (
        v_email_normalized, NULLIF(p_phone, ''), v_phone_e164, p_full_name, COALESCE(p_tags, '{}'),
        COALESCE(p_wa_opt_in, false), COALESCE(p_sms_opt_in, false), COALESCE(p_email_opt_in, true),
        CASE WHEN p_source = 'ghl' THEN p_external_id ELSE NULL END,
        CASE WHEN p_source = 'manychat' THEN p_external_id ELSE NULL END,
        'LEAD', now()
      ) RETURNING id INTO v_existing_client_id;
    END IF;

    v_action := 'inserted';

  ELSIF v_existing_client_id IS NOT NULL THEN
    -- Update existing client
    IF NOT p_dry_run THEN
      UPDATE public.clients SET
        phone = CASE
          WHEN p_source IN ('web', 'csv') AND NULLIF(p_phone, '') IS NOT NULL THEN p_phone
          WHEN phone IS NULL AND NULLIF(p_phone, '') IS NOT NULL THEN p_phone
          ELSE phone
        END,
        phone_e164 = CASE
          WHEN p_source IN ('web', 'csv') AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          WHEN phone_e164 IS NULL AND v_phone_e164 IS NOT NULL THEN v_phone_e164
          ELSE phone_e164
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

    IF v_action = 'none' THEN
      v_action := 'updated';
    END IF;
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

-- Keep explicit search_path for safety.
ALTER FUNCTION public.merge_contact(
  text, text, text, text, text, text[], boolean, boolean, boolean, jsonb, boolean, uuid
) SET search_path = public;
