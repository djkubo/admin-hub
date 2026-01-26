-- Table for tracking CSV import runs
CREATE TABLE public.csv_import_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  filename TEXT,
  source_type TEXT NOT NULL,
  total_rows INT DEFAULT 0,
  rows_staged INT DEFAULT 0,
  rows_merged INT DEFAULT 0,
  rows_conflict INT DEFAULT 0,
  rows_error INT DEFAULT 0,
  status TEXT DEFAULT 'staging',
  started_at TIMESTAMPTZ DEFAULT now(),
  staged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

-- Table for raw CSV data (staging)
CREATE TABLE public.csv_imports_raw (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES csv_import_runs(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  email TEXT,
  phone TEXT,
  full_name TEXT,
  source_type TEXT NOT NULL,
  raw_data JSONB NOT NULL,
  processing_status TEXT DEFAULT 'pending',
  merged_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Indexes for fast queries
CREATE INDEX idx_csv_imports_raw_import ON csv_imports_raw(import_id);
CREATE INDEX idx_csv_imports_raw_email ON csv_imports_raw(email);
CREATE INDEX idx_csv_imports_raw_phone ON csv_imports_raw(phone);
CREATE INDEX idx_csv_imports_raw_status ON csv_imports_raw(processing_status);
CREATE INDEX idx_csv_imports_raw_created ON csv_imports_raw(created_at DESC);
CREATE INDEX idx_csv_import_runs_status ON csv_import_runs(status);
CREATE INDEX idx_csv_import_runs_started ON csv_import_runs(started_at DESC);

-- Enable RLS
ALTER TABLE csv_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_imports_raw ENABLE ROW LEVEL SECURITY;

-- Admin-only policies (using existing is_admin function)
CREATE POLICY "csv_import_runs_admin_all" ON csv_import_runs
  FOR ALL USING (is_admin());
  
CREATE POLICY "csv_imports_raw_admin_all" ON csv_imports_raw
  FOR ALL USING (is_admin());

-- View that combines clients with pending staged contacts
CREATE VIEW public.clients_with_staging AS
  SELECT 
    id, email, full_name, phone, lifecycle_stage, total_spend,
    ghl_contact_id, stripe_customer_id, paypal_customer_id,
    manychat_subscriber_id, tags, created_at,
    'unified'::text as import_status,
    NULL::uuid as import_id
  FROM clients
  
  UNION ALL
  
  SELECT 
    r.id,
    r.email,
    r.full_name,
    r.phone,
    'STAGING'::text as lifecycle_stage,
    0::numeric as total_spend,
    r.raw_data->>'ghl_contact_id' as ghl_contact_id,
    r.raw_data->>'stripe_customer_id' as stripe_customer_id,
    r.raw_data->>'paypal_customer_id' as paypal_customer_id,
    r.raw_data->>'manychat_subscriber_id' as manychat_subscriber_id,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(r.raw_data->'tags')),
      ARRAY[]::text[]
    ) as tags,
    r.created_at,
    r.processing_status as import_status,
    r.import_id
  FROM csv_imports_raw r
  WHERE r.processing_status = 'pending';