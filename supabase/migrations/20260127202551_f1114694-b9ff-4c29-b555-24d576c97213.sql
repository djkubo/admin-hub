-- Tabla para cola de recuperación automática
CREATE TABLE IF NOT EXISTS recovery_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id TEXT NOT NULL,
  client_id UUID REFERENCES clients(id),
  stripe_customer_id TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  amount_due INTEGER NOT NULL,
  currency TEXT DEFAULT 'usd',
  failure_reason TEXT,
  failure_message TEXT,
  retry_at TIMESTAMPTZ NOT NULL,
  notification_sent_at TIMESTAMPTZ,
  notification_channel TEXT, -- 'sms' | 'whatsapp' | 'email'
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'retrying', 'recovered', 'failed', 'cancelled')),
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  portal_link_token TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  recovered_at TIMESTAMPTZ,
  recovered_amount INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(invoice_id)
);

-- Índices para consultas eficientes
CREATE INDEX idx_recovery_queue_status_retry ON recovery_queue(status, retry_at) 
  WHERE status IN ('pending', 'notified');
CREATE INDEX idx_recovery_queue_client ON recovery_queue(client_id);
CREATE INDEX idx_recovery_queue_invoice ON recovery_queue(invoice_id);

-- Tabla para links de actualización de tarjeta
CREATE TABLE IF NOT EXISTS payment_update_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  client_id UUID REFERENCES clients(id),
  stripe_customer_id TEXT NOT NULL,
  invoice_id TEXT,
  customer_email TEXT,
  customer_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_payment_links_token ON payment_update_links(token);
CREATE INDEX idx_payment_links_expires ON payment_update_links(expires_at) WHERE used_at IS NULL;

-- RLS políticas para recovery_queue
ALTER TABLE recovery_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access recovery_queue" ON recovery_queue
  FOR ALL USING (public.is_admin());

-- RLS políticas para payment_update_links
ALTER TABLE payment_update_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access payment_links" ON payment_update_links
  FOR ALL USING (public.is_admin());

-- Política pública para validar tokens (lectura limitada por token)
CREATE POLICY "Public can validate own token" ON payment_update_links
  FOR SELECT USING (true);

-- Trigger para actualizar updated_at en recovery_queue
CREATE OR REPLACE FUNCTION update_recovery_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_recovery_queue_updated_at
  BEFORE UPDATE ON recovery_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_recovery_queue_updated_at();