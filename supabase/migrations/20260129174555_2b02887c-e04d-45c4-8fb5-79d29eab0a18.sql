-- Create scheduled_messages table for chat scheduling
CREATE TABLE public.scheduled_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id TEXT NOT NULL,
  message TEXT,
  media_url TEXT,
  media_type TEXT,
  media_filename TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Anyone can view scheduled messages"
ON public.scheduled_messages FOR SELECT
USING (true);

CREATE POLICY "Authenticated users can create scheduled messages"
ON public.scheduled_messages FOR INSERT
WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update scheduled messages"
ON public.scheduled_messages FOR UPDATE
USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can delete scheduled messages"
ON public.scheduled_messages FOR DELETE
USING (auth.role() = 'authenticated');

-- Index for pending messages query
CREATE INDEX idx_scheduled_messages_pending 
ON public.scheduled_messages (scheduled_at) 
WHERE status = 'pending';

-- Trigger for updated_at
CREATE TRIGGER update_scheduled_messages_updated_at
BEFORE UPDATE ON public.scheduled_messages
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();