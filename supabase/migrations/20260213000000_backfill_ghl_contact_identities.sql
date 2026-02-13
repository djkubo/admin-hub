-- Backfill missing contact_identities rows for clients with GHL IDs.
-- This prevents merge/unify calls from treating known GHL contacts as new identities.

DO $$
DECLARE
  inserted_count integer;
BEGIN
  WITH ghl_candidates AS (
    SELECT
      c.id AS client_id,
      NULLIF(trim(c.ghl_contact_id), '') AS external_id,
      NULLIF(lower(trim(c.email)), '') AS email_normalized,
      NULLIF(c.phone_e164, '') AS phone_e164
    FROM public.clients c
    WHERE c.ghl_contact_id IS NOT NULL
      AND NULLIF(trim(c.ghl_contact_id), '') IS NOT NULL
  )
  INSERT INTO public.contact_identities (
    source,
    external_id,
    client_id,
    email_normalized,
    phone_e164,
    created_at,
    updated_at
  )
  SELECT
    'ghl',
    g.external_id,
    g.client_id,
    g.email_normalized,
    g.phone_e164,
    now(),
    now()
  FROM ghl_candidates g
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.contact_identities ci
    WHERE ci.source = 'ghl'
      AND ci.external_id = g.external_id
  )
  ON CONFLICT (source, external_id) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RAISE NOTICE 'Backfill complete: % new contact_identities rows inserted for source=ghl', inserted_count;
END $$;
