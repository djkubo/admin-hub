-- ============================================
-- AGGRESSIVE CLEANUP FOR DISK SPACE
-- Created: 2026-01-26
-- Purpose: Clean old data to free disk space and reduce IO
-- ============================================

-- ============================================
-- 1. CLEAN OLD RAW CONTACTS (keep only last 30 days)
-- ============================================

-- GHL Contacts Raw: Delete old records (keep only last 30 days)
-- These are staging data, we can safely delete old ones
DELETE FROM public.ghl_contacts_raw 
WHERE fetched_at < NOW() - INTERVAL '30 days';

-- ManyChat Contacts Raw: Delete old records (keep only last 30 days)
DELETE FROM public.manychat_contacts_raw 
WHERE fetched_at < NOW() - INTERVAL '30 days';

-- ============================================
-- 2. CLEAN OLD SYNC RUNS (keep only last 14 days)
-- ============================================

-- Delete old completed/failed sync runs (keep last 14 days for debugging)
DELETE FROM public.sync_runs 
WHERE status IN ('completed', 'failed', 'error', 'cancelled')
  AND started_at < NOW() - INTERVAL '14 days';

-- ============================================
-- 3. CLEAN OLD WEBHOOK EVENTS (keep only last 30 days)
-- ============================================

-- Delete old processed webhook events
DELETE FROM public.webhook_events 
WHERE processed_at IS NOT NULL 
  AND processed_at < NOW() - INTERVAL '30 days';

-- ============================================
-- 4. CLEAN OLD CLIENT EVENTS (keep only last 90 days)
-- ============================================

-- Delete very old client events (keep last 90 days for analytics)
DELETE FROM public.client_events 
WHERE created_at < NOW() - INTERVAL '90 days';

-- ============================================
-- 5. CLEAN OLD CAMPAIGN EXECUTIONS (keep only last 60 days)
-- ============================================

-- Delete old campaign executions
DELETE FROM public.campaign_executions 
WHERE created_at < NOW() - INTERVAL '60 days';

-- ============================================
-- 6. VACUUM AND ANALYZE (reclaim disk space)
-- ============================================

-- VACUUM FULL reclaims space but locks tables - use with caution
-- VACUUM ANALYZE is safer and updates statistics
VACUUM ANALYZE public.ghl_contacts_raw;
VACUUM ANALYZE public.manychat_contacts_raw;
VACUUM ANALYZE public.sync_runs;
VACUUM ANALYZE public.webhook_events;
VACUUM ANALYZE public.client_events;
VACUUM ANALYZE public.campaign_executions;

-- ============================================
-- 7. FUNCTION FOR ONGOING CLEANUP
-- ============================================

-- Create a function to run cleanup regularly
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
  v_webhooks_deleted integer;
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
  
  -- Clean old webhook events (30 days)
  WITH deleted AS (
    DELETE FROM public.webhook_events 
    WHERE processed_at IS NOT NULL 
      AND processed_at < NOW() - INTERVAL '30 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_webhooks_deleted FROM deleted;
  
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
    'webhook_events_deleted', v_webhooks_deleted,
    'client_events_deleted', v_events_deleted,
    'campaign_executions_deleted', v_campaigns_deleted,
    'executed_at', NOW()
  );
  
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_data() TO authenticated;

COMMENT ON FUNCTION public.cleanup_old_data() IS 'Cleans old staging data, sync runs, and events to free disk space. Safe to run regularly.';
