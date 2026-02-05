-- Enable pg_trgm extension for trigram indexes (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================
-- 1. GIN TRIGRAM INDEXES FOR FAST TEXT SEARCH
-- ============================================

-- Clients: full_name, email, phone for ILIKE searches
CREATE INDEX IF NOT EXISTS idx_clients_full_name_trgm 
ON clients USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_clients_email_trgm 
ON clients USING GIN (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_clients_phone_trgm 
ON clients USING GIN (phone gin_trgm_ops);

-- Transactions: customer_email, stripe_payment_intent_id for search
CREATE INDEX IF NOT EXISTS idx_transactions_customer_email_trgm 
ON transactions USING GIN (customer_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_transactions_payment_intent_trgm 
ON transactions USING GIN (stripe_payment_intent_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_transactions_external_id_trgm 
ON transactions USING GIN (external_transaction_id gin_trgm_ops);

-- ============================================
-- 2. BTREE INDEXES FOR COMMON FILTERS
-- ============================================

-- Clients: lifecycle_stage and is_delinquent filters
CREATE INDEX IF NOT EXISTS idx_clients_lifecycle_stage 
ON clients (lifecycle_stage);

CREATE INDEX IF NOT EXISTS idx_clients_is_delinquent 
ON clients (is_delinquent) WHERE is_delinquent = true;

CREATE INDEX IF NOT EXISTS idx_clients_payment_status 
ON clients (payment_status);

-- Invoices: status filter (most common)
CREATE INDEX IF NOT EXISTS idx_invoices_status 
ON invoices (status);

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_customer 
ON invoices (stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_invoices_client_id 
ON invoices (client_id);

-- Transactions: status and source filters
CREATE INDEX IF NOT EXISTS idx_transactions_status 
ON transactions (status);

CREATE INDEX IF NOT EXISTS idx_transactions_source 
ON transactions (source);

CREATE INDEX IF NOT EXISTS idx_transactions_status_source 
ON transactions (status, source);

-- Subscriptions: status and plan_name filters
CREATE INDEX IF NOT EXISTS idx_subscriptions_status 
ON subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_name 
ON subscriptions (plan_name);

-- ============================================
-- 3. SORTING INDEXES (DESCENDING FOR RECENCY)
-- ============================================

-- Clients: total_spend DESC for leaderboard/VIP views
CREATE INDEX IF NOT EXISTS idx_clients_total_spend_desc 
ON clients (total_spend DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_clients_created_at_desc 
ON clients (created_at DESC NULLS LAST);

-- Transactions: stripe_created_at DESC for movements page
CREATE INDEX IF NOT EXISTS idx_transactions_created_at_desc 
ON transactions (stripe_created_at DESC NULLS LAST);

-- Invoices: stripe_created_at DESC for invoice lists
CREATE INDEX IF NOT EXISTS idx_invoices_created_at_desc 
ON invoices (stripe_created_at DESC NULLS LAST);

-- ============================================
-- 4. COMPOSITE INDEXES FOR COMMON QUERY PATTERNS
-- ============================================

-- Transactions: status + date range (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_transactions_status_date 
ON transactions (status, stripe_created_at DESC NULLS LAST);

-- Invoices: status + date range
CREATE INDEX IF NOT EXISTS idx_invoices_status_date 
ON invoices (status, stripe_created_at DESC NULLS LAST);

-- Clients: lifecycle_stage + created_at for funnel analysis
CREATE INDEX IF NOT EXISTS idx_clients_lifecycle_created 
ON clients (lifecycle_stage, created_at DESC NULLS LAST);