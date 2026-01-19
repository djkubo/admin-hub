-- Create enum for event types
CREATE TYPE public.client_event_type AS ENUM (
  'email_open',
  'email_click',
  'email_bounce',
  'email_sent',
  'payment_failed',
  'payment_success',
  'high_usage',
  'trial_started',
  'trial_converted',
  'churn_risk',
  'support_ticket',
  'login',
  'custom'
);

-- Create client_events table for tracking client history
CREATE TABLE public.client_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  event_type client_event_type NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster queries
CREATE INDEX idx_client_events_client_id ON public.client_events(client_id);
CREATE INDEX idx_client_events_type ON public.client_events(event_type);
CREATE INDEX idx_client_events_created_at ON public.client_events(created_at DESC);

-- Enable RLS
ALTER TABLE public.client_events ENABLE ROW LEVEL SECURITY;

-- RLS policies for authenticated users
CREATE POLICY "Authenticated users can view client events"
ON public.client_events FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert client events"
ON public.client_events FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can delete client events"
ON public.client_events FOR DELETE
TO authenticated
USING (true);

-- Create ai_insights table for daily AI reports
CREATE TABLE public.ai_insights (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  opportunities JSONB DEFAULT '[]'::jsonb,
  risks JSONB DEFAULT '[]'::jsonb,
  metrics JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster date queries
CREATE INDEX idx_ai_insights_date ON public.ai_insights(date DESC);

-- Enable RLS
ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

-- RLS policies for authenticated users
CREATE POLICY "Authenticated users can view ai insights"
ON public.ai_insights FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert ai insights"
ON public.ai_insights FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update ai insights"
ON public.ai_insights FOR UPDATE
TO authenticated
USING (true);

-- Enable realtime for client_events (for live updates)
ALTER PUBLICATION supabase_realtime ADD TABLE public.client_events;