-- 1. Optimizar búsqueda por chat_id (GHL y ManyChat)
CREATE INDEX IF NOT EXISTS idx_clients_ghl_id ON clients(ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_clients_manychat_id ON clients(manychat_subscriber_id);

-- 2. Optimizar búsqueda por Email y Teléfono (Para unificación)
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

-- 3. Optimizar el historial de chat (Para que el bot lea rápido)
CREATE INDEX IF NOT EXISTS idx_chat_events_contact_id ON chat_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_events_created_at ON chat_events(created_at DESC);