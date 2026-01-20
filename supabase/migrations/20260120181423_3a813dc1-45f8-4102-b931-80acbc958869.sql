-- Create unified messages table for CRM inbox
CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  from_address TEXT, -- Phone number or email
  to_address TEXT,
  subject TEXT, -- For emails
  body TEXT NOT NULL,
  external_message_id TEXT, -- Twilio SID, SES Message ID
  status TEXT DEFAULT 'sent' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  read_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for fast lookups
CREATE INDEX idx_messages_client_id ON public.messages(client_id);
CREATE INDEX idx_messages_channel ON public.messages(channel);
CREATE INDEX idx_messages_created_at ON public.messages(created_at DESC);
CREATE INDEX idx_messages_direction ON public.messages(direction);

-- Enable RLS
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Policy for authenticated users (admin access)
CREATE POLICY "Admins can manage messages"
  ON public.messages
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.app_admins WHERE user_id = auth.uid())
  );

-- Enable Realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;

-- Add comment
COMMENT ON TABLE public.messages IS 'Unified inbox for all customer communications (SMS, WhatsApp, Email)';