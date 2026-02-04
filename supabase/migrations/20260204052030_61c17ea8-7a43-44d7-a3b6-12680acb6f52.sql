-- Índices para filtrar registros no procesados (95% de las queries)
CREATE INDEX IF NOT EXISTS idx_ghl_raw_unprocessed 
ON ghl_contacts_raw(fetched_at) 
WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mc_raw_unprocessed 
ON manychat_contacts_raw(fetched_at) 
WHERE processed_at IS NULL;

-- Índices para búsqueda de clientes (identity unification)
CREATE INDEX IF NOT EXISTS idx_clients_email_lower 
ON clients(LOWER(email)) 
WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_phone_e164 
ON clients(phone_e164) 
WHERE phone_e164 IS NOT NULL;