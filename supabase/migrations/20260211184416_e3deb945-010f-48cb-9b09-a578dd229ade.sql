
CREATE TABLE public.sync_state (
  source text PRIMARY KEY,
  backfill_start timestamptz,
  fresh_until timestamptz,
  last_success_at timestamptz,
  last_success_run_id uuid,
  last_success_status text,
  last_success_meta jsonb DEFAULT '{}'::jsonb,
  last_error_at timestamptz,
  last_error_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage sync_state"
  ON public.sync_state FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());
