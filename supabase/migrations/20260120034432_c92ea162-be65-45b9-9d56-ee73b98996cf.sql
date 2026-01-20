-- STEP 1: Delete duplicate clients keeping only the oldest one per normalized email
-- This uses a CTE to identify which records to delete

WITH ranked_clients AS (
  SELECT 
    id,
    email,
    lower(trim(email)) as normalized_email,
    ROW_NUMBER() OVER (
      PARTITION BY lower(trim(email)) 
      ORDER BY created_at ASC NULLS LAST, id
    ) as rn
  FROM clients
  WHERE email IS NOT NULL
),
duplicates_to_delete AS (
  SELECT id FROM ranked_clients WHERE rn > 1
)
DELETE FROM clients WHERE id IN (SELECT id FROM duplicates_to_delete);

-- STEP 2: Now normalize all remaining emails (should be safe now)
UPDATE clients 
SET email = lower(trim(email))
WHERE email IS NOT NULL AND (email != lower(email) OR email != trim(email));

-- STEP 3: Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_sync_runs_source_status ON sync_runs(source, status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_source_processed ON webhook_events(source, processed_at DESC);