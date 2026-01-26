-- Limpieza agresiva de datos antiguos para liberar espacio en disco

-- 1. GHL Contacts Raw (mantener solo últimos 30 días)
DELETE FROM public.ghl_contacts_raw 
WHERE fetched_at < NOW() - INTERVAL '30 days';

-- 2. ManyChat Contacts Raw (mantener solo últimos 30 días)
DELETE FROM public.manychat_contacts_raw 
WHERE fetched_at < NOW() - INTERVAL '30 days';

-- 3. Sync Runs antiguos (mantener solo últimos 14 días)
DELETE FROM public.sync_runs 
WHERE status IN ('completed', 'failed', 'error', 'cancelled')
AND started_at < NOW() - INTERVAL '14 days';

-- 4. Client Events antiguos (mantener solo últimos 90 días)
DELETE FROM public.client_events 
WHERE created_at < NOW() - INTERVAL '90 days';

-- 5. Campaign Executions antiguos (mantener solo últimos 60 días)
DELETE FROM public.campaign_executions 
WHERE created_at < NOW() - INTERVAL '60 days';

-- Crear función de limpieza automática
CREATE OR REPLACE FUNCTION public.cleanup_old_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ghl_deleted integer;
  v_manychat_deleted integer;
  v_sync_runs_deleted integer;
  v_events_deleted integer;
  v_campaigns_deleted integer;
  v_result jsonb;
BEGIN
  -- Clean GHL raw contacts (30 days)
  WITH deleted AS (
    DELETE FROM public.ghl_contacts_raw 
    WHERE fetched_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_ghl_deleted FROM deleted;

  -- Clean ManyChat raw contacts (30 days)
  WITH deleted AS (
    DELETE FROM public.manychat_contacts_raw 
    WHERE fetched_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_manychat_deleted FROM deleted;

  -- Clean old sync runs (14 days)
  WITH deleted AS (
    DELETE FROM public.sync_runs 
    WHERE status IN ('completed', 'failed', 'error', 'cancelled')
    AND started_at < NOW() - INTERVAL '14 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_sync_runs_deleted FROM deleted;

  -- Clean old client events (90 days)
  WITH deleted AS (
    DELETE FROM public.client_events 
    WHERE created_at < NOW() - INTERVAL '90 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_events_deleted FROM deleted;

  -- Clean old campaign executions (60 days)
  WITH deleted AS (
    DELETE FROM public.campaign_executions 
    WHERE created_at < NOW() - INTERVAL '60 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_campaigns_deleted FROM deleted;

  v_result := jsonb_build_object(
    'ghl_contacts_deleted', v_ghl_deleted,
    'manychat_contacts_deleted', v_manychat_deleted,
    'sync_runs_deleted', v_sync_runs_deleted,
    'client_events_deleted', v_events_deleted,
    'campaign_executions_deleted', v_campaigns_deleted,
    'executed_at', NOW()
  );

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.cleanup_old_data() TO authenticated;