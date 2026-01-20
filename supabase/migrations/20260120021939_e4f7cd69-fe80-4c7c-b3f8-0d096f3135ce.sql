-- Create campaign_rules table for the Rules Engine
CREATE TABLE public.campaign_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_event TEXT NOT NULL, -- payment_failed, trial_started, trial_end_24h, canceled, invoice_open
  is_active BOOLEAN DEFAULT true,
  channel_priority TEXT[] DEFAULT ARRAY['whatsapp', 'sms', 'manychat', 'ghl'],
  template_type TEXT NOT NULL DEFAULT 'friendly', -- friendly, urgent, final
  delay_minutes INTEGER DEFAULT 0, -- delay before sending
  max_attempts INTEGER DEFAULT 3,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create campaign_executions table to track sent campaigns
CREATE TABLE public.campaign_executions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_id UUID REFERENCES public.campaign_rules(id) ON DELETE SET NULL,
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL,
  channel_used TEXT, -- whatsapp, sms, manychat, ghl
  status TEXT NOT NULL DEFAULT 'pending', -- pending, sent, delivered, replied, converted, failed, opted_out
  attempt_number INTEGER DEFAULT 1,
  message_content TEXT,
  external_message_id TEXT, -- Twilio SID, ManyChat ID, etc.
  revenue_at_risk NUMERIC DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create opt_outs table to respect STOP requests
CREATE TABLE public.opt_outs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- whatsapp, sms, manychat, all
  opted_out_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  reason TEXT
);

-- Add revenue_score to clients for prioritization
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS revenue_score INTEGER DEFAULT 0;

-- Enable RLS on new tables
ALTER TABLE public.campaign_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opt_outs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for campaign_rules
CREATE POLICY "Admin can view campaign_rules" ON public.campaign_rules FOR SELECT USING (is_admin());
CREATE POLICY "Admin can insert campaign_rules" ON public.campaign_rules FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Admin can update campaign_rules" ON public.campaign_rules FOR UPDATE USING (is_admin());
CREATE POLICY "Admin can delete campaign_rules" ON public.campaign_rules FOR DELETE USING (is_admin());

-- RLS Policies for campaign_executions
CREATE POLICY "Admin can view campaign_executions" ON public.campaign_executions FOR SELECT USING (is_admin());
CREATE POLICY "Admin can insert campaign_executions" ON public.campaign_executions FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Admin can update campaign_executions" ON public.campaign_executions FOR UPDATE USING (is_admin());
CREATE POLICY "Admin can delete campaign_executions" ON public.campaign_executions FOR DELETE USING (is_admin());

-- RLS Policies for opt_outs
CREATE POLICY "Admin can view opt_outs" ON public.opt_outs FOR SELECT USING (is_admin());
CREATE POLICY "Admin can insert opt_outs" ON public.opt_outs FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Admin can update opt_outs" ON public.opt_outs FOR UPDATE USING (is_admin());
CREATE POLICY "Admin can delete opt_outs" ON public.opt_outs FOR DELETE USING (is_admin());

-- Enable realtime for campaign_executions
ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_executions;

-- Insert default campaign rules
INSERT INTO public.campaign_rules (name, description, trigger_event, template_type, delay_minutes, max_attempts) VALUES
('Pago Fallido - Inmediato', 'Contactar inmediatamente cuando falla un pago', 'payment_failed', 'friendly', 0, 3),
('Trial Iniciado - Bienvenida', 'Mensaje de bienvenida al iniciar trial', 'trial_started', 'friendly', 5, 1),
('Trial Vence 24h', 'Recordatorio urgente de conversión', 'trial_end_24h', 'urgent', 0, 2),
('Cancelación - Winback', 'Intentar recuperar cliente que cancela', 'canceled', 'friendly', 60, 2),
('Factura Abierta', 'Recordatorio de factura pendiente', 'invoice_open', 'friendly', 1440, 2);

-- Create index for faster lookups
CREATE INDEX idx_campaign_executions_client ON public.campaign_executions(client_id);
CREATE INDEX idx_campaign_executions_status ON public.campaign_executions(status);
CREATE INDEX idx_opt_outs_client_channel ON public.opt_outs(client_id, channel);