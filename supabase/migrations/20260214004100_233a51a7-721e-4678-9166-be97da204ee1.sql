-- Better index for bulk-unify-contacts query:
-- SELECT ... FROM ghl_contacts_raw WHERE processed_at IS NULL ORDER BY fetched_at ASC LIMIT N
DROP INDEX IF EXISTS idx_ghl_raw_unprocessed;
CREATE INDEX idx_ghl_raw_unprocessed ON public.ghl_contacts_raw (fetched_at ASC)
  WHERE processed_at IS NULL;

-- Same pattern for manychat_contacts_raw
CREATE INDEX IF NOT EXISTS idx_manychat_raw_unprocessed
  ON public.manychat_contacts_raw (fetched_at ASC)
  WHERE processed_at IS NULL;