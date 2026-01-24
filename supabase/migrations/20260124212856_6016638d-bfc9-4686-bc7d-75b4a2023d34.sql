-- 1. Run VACUUM ANALYZE on heavy tables to update statistics and improve query planning
ANALYZE clients;
ANALYZE transactions;
ANALYZE sync_runs;
ANALYZE merge_conflicts;
ANALYZE subscriptions;
ANALYZE webhook_events;

-- 2. Add missing composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_sync_runs_status_source 
ON sync_runs(status, source) 
WHERE status IN ('running', 'continuing');

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at_desc 
ON sync_runs(started_at DESC);

-- 3. Add index for merge_conflicts cleanup
CREATE INDEX IF NOT EXISTS idx_merge_conflicts_status_created 
ON merge_conflicts(status, created_at DESC);

-- 4. Add index for fast webhook_events lookup
CREATE INDEX IF NOT EXISTS idx_webhook_events_source_processed 
ON webhook_events(source, processed_at DESC);