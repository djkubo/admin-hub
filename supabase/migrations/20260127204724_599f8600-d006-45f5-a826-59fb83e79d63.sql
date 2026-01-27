-- Crear wrapper compatible con el script Python
-- Acepta los parámetros en el orden que el script envía
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
SET search_path = public
AS $$
BEGIN
  -- Delegar a la función principal con el orden correcto
  RETURN unify_identity(
    p_source,
    p_email,
    p_phone,
    p_full_name,
    NULL,  -- p_stripe_customer_id
    NULL,  -- p_paypal_customer_id
    p_ghl_contact_id,
    p_manychat_subscriber_id,
    NULL,  -- p_tags
    NULL,  -- p_opt_in
    p_tracking_data
  );
END;
$$;

-- Dar permisos para que pueda ser llamada
GRANT EXECUTE ON FUNCTION public.unify_identity_v2 TO anon, authenticated, service_role;