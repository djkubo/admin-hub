-- Add UTM fields and lead-specific columns to clients
ALTER TABLE public.clients 
ADD COLUMN IF NOT EXISTS utm_source text,
ADD COLUMN IF NOT EXISTS utm_medium text,
ADD COLUMN IF NOT EXISTS utm_campaign text,
ADD COLUMN IF NOT EXISTS utm_content text,
ADD COLUMN IF NOT EXISTS utm_term text,
ADD COLUMN IF NOT EXISTS lead_status text DEFAULT 'lead',
ADD COLUMN IF NOT EXISTS last_lead_at timestamp with time zone;

-- Add contact info columns to lead_events for easier querying
ALTER TABLE public.lead_events
ADD COLUMN IF NOT EXISTS email text,
ADD COLUMN IF NOT EXISTS phone text,
ADD COLUMN IF NOT EXISTS full_name text;

-- Create indexes for lead analytics
CREATE INDEX IF NOT EXISTS idx_clients_lead_status ON public.clients(lead_status);
CREATE INDEX IF NOT EXISTS idx_clients_utm_source ON public.clients(utm_source);
CREATE INDEX IF NOT EXISTS idx_lead_events_email ON public.lead_events(email);
CREATE INDEX IF NOT EXISTS idx_lead_events_processed ON public.lead_events(processed_at DESC);