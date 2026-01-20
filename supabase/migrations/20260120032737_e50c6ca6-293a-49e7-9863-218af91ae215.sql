-- Add attribution fields to clients table
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS acquisition_source text,
ADD COLUMN IF NOT EXISTS acquisition_campaign text,
ADD COLUMN IF NOT EXISTS acquisition_medium text,
ADD COLUMN IF NOT EXISTS acquisition_content text,
ADD COLUMN IF NOT EXISTS first_seen_at timestamp with time zone DEFAULT now();

-- Create lead_events table for idempotency
CREATE TABLE IF NOT EXISTS public.lead_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  client_id uuid REFERENCES public.clients(id),
  payload jsonb DEFAULT '{}'::jsonb,
  processed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT lead_events_source_event_id_key UNIQUE(source, event_id)
);

-- Enable RLS
ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

-- Admin-only policies for lead_events
CREATE POLICY "Admin can manage lead_events" ON public.lead_events
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_lead_events_source_event ON public.lead_events(source, event_id);
CREATE INDEX IF NOT EXISTS idx_clients_acquisition_source ON public.clients(acquisition_source);
CREATE INDEX IF NOT EXISTS idx_clients_first_seen_at ON public.clients(first_seen_at);