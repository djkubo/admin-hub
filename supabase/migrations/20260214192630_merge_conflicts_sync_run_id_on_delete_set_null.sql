-- Make merge_conflicts resilient to sync_runs retention/cleanup.
-- sync_run_id is an audit pointer and should not prevent deleting old runs.

ALTER TABLE public.merge_conflicts
  DROP CONSTRAINT IF EXISTS merge_conflicts_sync_run_id_fkey;

ALTER TABLE public.merge_conflicts
  ADD CONSTRAINT merge_conflicts_sync_run_id_fkey
  FOREIGN KEY (sync_run_id)
  REFERENCES public.sync_runs (id)
  ON DELETE SET NULL;
