-- Add clients_without_source check to data_quality_checks function
CREATE OR REPLACE FUNCTION public.data_quality_checks()
 RETURNS TABLE(check_name text, status text, count bigint, percentage numeric, details jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  
  -- Check 1: Payments without email
  SELECT 
    'payments_without_email'::text as check_name,
    CASE WHEN COUNT(*) FILTER (WHERE t.customer_email IS NULL) * 100.0 / NULLIF(COUNT(*), 0) > 5 
      THEN 'warning' ELSE 'ok' END::text as status,
    COUNT(*) FILTER (WHERE t.customer_email IS NULL)::bigint as count,
    ROUND(COUNT(*) FILTER (WHERE t.customer_email IS NULL) * 100.0 / NULLIF(COUNT(*), 0), 2)::numeric as percentage,
    jsonb_build_object('total', COUNT(*)) as details
  FROM transactions t
  WHERE t.status = 'succeeded'
  
  UNION ALL
  
  -- Check 2: Clients without phone
  SELECT 
    'clients_without_phone'::text,
    'info'::text,
    COUNT(*) FILTER (WHERE c.phone IS NULL)::bigint,
    ROUND(COUNT(*) FILTER (WHERE c.phone IS NULL) * 100.0 / NULLIF(COUNT(*), 0), 2)::numeric,
    jsonb_build_object('total', COUNT(*))
  FROM clients c
  
  UNION ALL
  
  -- Check 3: Duplicate phones
  SELECT 
    'duplicate_phones'::text,
    CASE WHEN COUNT(*) > 0 THEN 'warning' ELSE 'ok' END::text,
    COUNT(*)::bigint,
    0::numeric,
    COALESCE(jsonb_build_object('phones', jsonb_agg(dups.phone)), '{}'::jsonb)
  FROM (
    SELECT c.phone, COUNT(*) as cnt
    FROM clients c
    WHERE c.phone IS NOT NULL AND c.phone != ''
    GROUP BY c.phone
    HAVING COUNT(*) > 1
    LIMIT 10
  ) dups
  
  UNION ALL
  
  -- Check 4: Non-normalized emails
  SELECT 
    'non_normalized_emails'::text,
    CASE WHEN COUNT(*) > 0 THEN 'critical' ELSE 'ok' END::text,
    COUNT(*)::bigint,
    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM clients WHERE email IS NOT NULL), 0), 2)::numeric,
    COALESCE(jsonb_build_object('sample', jsonb_agg(bad.email)), '{}'::jsonb)
  FROM (
    SELECT c.email
    FROM clients c
    WHERE c.email IS NOT NULL 
      AND (c.email != lower(c.email) OR c.email != trim(c.email))
    LIMIT 10
  ) bad
  
  UNION ALL
  
  -- Check 5: Mixed currencies in period
  SELECT 
    'mixed_currencies'::text,
    CASE WHEN COUNT(DISTINCT t.currency) > 1 THEN 'info' ELSE 'ok' END::text,
    COUNT(DISTINCT t.currency)::bigint,
    0::numeric,
    COALESCE(jsonb_agg(DISTINCT t.currency), '[]'::jsonb)
  FROM transactions t
  WHERE t.created_at >= NOW() - INTERVAL '30 days'
    AND t.status = 'succeeded'
    
  UNION ALL
  
  -- Check 6: Clients without attribution source
  SELECT 
    'clients_without_source'::text,
    CASE WHEN COUNT(*) FILTER (WHERE c.acquisition_source IS NULL) * 100.0 / NULLIF(COUNT(*), 0) > 30 
      THEN 'warning' ELSE 'info' END::text,
    COUNT(*) FILTER (WHERE c.acquisition_source IS NULL)::bigint,
    ROUND(COUNT(*) FILTER (WHERE c.acquisition_source IS NULL) * 100.0 / NULLIF(COUNT(*), 0), 2)::numeric,
    jsonb_build_object('total', COUNT(*))
  FROM clients c;
END;
$function$;