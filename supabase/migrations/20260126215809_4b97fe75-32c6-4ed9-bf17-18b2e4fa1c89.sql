-- Drop and recreate view with security_invoker
DROP VIEW IF EXISTS public.clients_with_staging;

CREATE VIEW public.clients_with_staging 
WITH (security_invoker = on) AS
  SELECT 
    id, email, full_name, phone, lifecycle_stage, total_spend,
    ghl_contact_id, stripe_customer_id, paypal_customer_id,
    manychat_subscriber_id, tags, created_at,
    'unified'::text as import_status,
    NULL::uuid as import_id
  FROM clients
  
  UNION ALL
  
  SELECT 
    r.id,
    r.email,
    r.full_name,
    r.phone,
    'STAGING'::text as lifecycle_stage,
    0::numeric as total_spend,
    r.raw_data->>'ghl_contact_id' as ghl_contact_id,
    r.raw_data->>'stripe_customer_id' as stripe_customer_id,
    r.raw_data->>'paypal_customer_id' as paypal_customer_id,
    r.raw_data->>'manychat_subscriber_id' as manychat_subscriber_id,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(r.raw_data->'tags')),
      ARRAY[]::text[]
    ) as tags,
    r.created_at,
    r.processing_status as import_status,
    r.import_id
  FROM csv_imports_raw r
  WHERE r.processing_status = 'pending';