-- Templates multicanal con variables y versiones
CREATE TABLE public.message_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'messenger')),
  subject TEXT, -- For email only
  content TEXT NOT NULL,
  variables TEXT[] DEFAULT '{}', -- e.g. {name, amount, days_left}
  version INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Historial de versiones de templates
CREATE TABLE public.template_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id UUID REFERENCES public.message_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  subject TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by TEXT
);

-- Segmentos dinámicos
CREATE TABLE public.segments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  filter_type TEXT NOT NULL, -- payment_failed, trial_expiring, lead_no_trial, canceled, vip, custom
  filter_criteria JSONB DEFAULT '{}', -- Custom filters: {days_left: 3, min_amount: 100, etc.}
  exclude_refunds BOOLEAN DEFAULT true,
  exclude_no_phone BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Campañas manuales
CREATE TABLE public.campaigns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  segment_id UUID REFERENCES public.segments(id) ON DELETE SET NULL,
  template_id UUID REFERENCES public.message_templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled')),
  channel TEXT NOT NULL,
  
  -- Guardrails
  respect_opt_out BOOLEAN DEFAULT true,
  quiet_hours_start TIME DEFAULT '22:00',
  quiet_hours_end TIME DEFAULT '09:00',
  respect_quiet_hours BOOLEAN DEFAULT false, -- Disabled by default
  rate_limit_per_minute INTEGER DEFAULT 30,
  dedupe_hours INTEGER DEFAULT 24,
  dry_run BOOLEAN DEFAULT false,
  
  -- Stats
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  replied_count INTEGER DEFAULT 0,
  converted_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  
  scheduled_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Recipients de cada campaña
CREATE TABLE public.campaign_recipients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'excluded', 'sent', 'delivered', 'replied', 'converted', 'failed', 'opted_out', 'deduped', 'quiet_hours')),
  exclusion_reason TEXT,
  external_message_id TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  replied_at TIMESTAMP WITH TIME ZONE,
  converted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Admin access message_templates" ON public.message_templates FOR ALL USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admin access template_versions" ON public.template_versions FOR ALL USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admin access segments" ON public.segments FOR ALL USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admin access campaigns" ON public.campaigns FOR ALL USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admin access campaign_recipients" ON public.campaign_recipients FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Indexes
CREATE INDEX idx_campaign_recipients_campaign ON public.campaign_recipients(campaign_id);
CREATE INDEX idx_campaign_recipients_status ON public.campaign_recipients(status);
CREATE INDEX idx_campaigns_status ON public.campaigns(status);

-- Default segments
INSERT INTO public.segments (name, description, filter_type, exclude_refunds, exclude_no_phone) VALUES
('Pagos Fallidos', 'Clientes con al menos un pago fallido en últimos 30 días', 'payment_failed', true, false),
('Trials por Vencer (3d)', 'Trials que vencen en los próximos 3 días', 'trial_expiring', true, false),
('Leads sin Trial', 'Prospectos que nunca iniciaron trial', 'lead_no_trial', true, false),
('Cancelados Recientes', 'Cancelaciones en últimos 30 días (winback)', 'canceled', true, false),
('VIP', 'Clientes con total_spend > $1000', 'vip', true, false),
('Todos con Teléfono', 'Todos los clientes con teléfono registrado', 'custom', true, true);

-- Default templates
INSERT INTO public.message_templates (name, channel, content, variables) VALUES
('Pago Fallido - Amigable (WA)', 'whatsapp', 'Hola {{name}} 👋 Notamos que tu pago de {{amount}} no se procesó. ¿Te podemos ayudar? Responde aquí.', '{name,amount}'),
('Pago Fallido - Urgente (WA)', 'whatsapp', '⚠️ {{name}}, tu pago de {{amount}} falló. Para evitar suspensión, actualiza tu método de pago hoy.', '{name,amount}'),
('Pago Fallido - Final (WA)', 'whatsapp', '🚨 ÚLTIMO AVISO {{name}}: Servicio suspendido en 24h por falta de pago ({{amount}}).', '{name,amount}'),
('Trial Vence (WA)', 'whatsapp', 'Hola {{name}}, tu prueba gratuita termina en {{days_left}} días. ¿Listo para activar tu plan?', '{name,days_left}'),
('Winback (WA)', 'whatsapp', 'Hola {{name}}, te extrañamos 😢 ¿Hay algo que podamos mejorar? Tenemos una oferta especial para ti.', '{name}'),
('Pago Fallido (SMS)', 'sms', '{{name}}, tu pago de {{amount}} falló. Actualiza tu método de pago para evitar suspensión.', '{name,amount}'),
('Trial Vence (SMS)', 'sms', '{{name}}, tu trial vence en {{days_left}} días. Activa tu plan ahora.', '{name,days_left}'),
('Pago Fallido (Messenger)', 'messenger', 'Hola {{name}} 👋 Tu pago de {{amount}} no se procesó. ¿Necesitas ayuda?', '{name,amount}');

-- Disable automation in campaign_rules by default
UPDATE public.campaign_rules SET is_active = false;