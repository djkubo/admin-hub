-- ============================================
-- CLEANUP STUCK SYNCS FUNCTION
-- Created: 2026-01-26
-- Purpose: Automatically clean up syncs that have been running for too long
-- ============================================

-- Function to mark stuck syncs as failed
CREATE OR REPLACE FUNCTION public.cleanup_stuck_syncs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_stuck_count integer;
  v_result jsonb;
BEGIN
  -- Mark syncs running > 30 minutes as failed
  WITH updated AS (
    UPDATE sync_runs 
    SET status = 'failed',
        error_message = 'Timeout - sync exceeded 30 minute limit',
        completed_at = NOW()
    WHERE status IN ('running', 'continuing') 
      AND started_at < NOW() - INTERVAL '30 minutes'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_stuck_count FROM updated;
  
  v_result := jsonb_build_object(
    'stuck_syncs_fixed', v_stuck_count,
    'executed_at', NOW()
  );
  
  RETURN v_result;
END;
$$;

-- Grant execute permission to authenticated users (admins via is_admin())
GRANT EXECUTE ON FUNCTION public.cleanup_stuck_syncs() TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.cleanup_stuck_syncs() IS 'Marks syncs running for more than 30 minutes as failed. Returns count of fixed syncs.';

-- ============================================
-- OPTIONAL: Clean up old completed syncs
-- (Run manually or via cron, not automatically)
-- ============================================

-- Function to clean old sync runs (optional, for maintenance)
CREATE OR REPLACE FUNCTION public.cleanup_old_sync_runs(days_to_keep integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_deleted_count integer;
  v_result jsonb;
BEGIN
  -- Delete old completed/failed syncs
  WITH deleted AS (
    DELETE FROM sync_runs 
    WHERE status IN ('completed', 'failed', 'error', 'cancelled')
      AND started_at < NOW() - (days_to_keep || ' days')::INTERVAL
    RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted_count FROM deleted;
  
  v_result := jsonb_build_object(
    'deleted_count', v_deleted_count,
    'days_kept', days_to_keep,
    'executed_at', NOW()
  );
  
  RETURN v_result;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.cleanup_old_sync_runs(integer) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.cleanup_old_sync_runs(integer) IS 'Deletes old sync_runs records. Default keeps 7 days. Use with caution.';
