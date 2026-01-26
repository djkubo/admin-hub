-- ============================================
-- VERIFICACIÓN COMPLETA DE BASE DE DATOS
-- Ejecuta esto en el SQL Editor de Supabase
-- ============================================

-- 1. VERIFICAR TABLAS PRINCIPALES
SELECT 
  'TABLAS' as tipo,
  table_name as nombre,
  CASE 
    WHEN table_name IN ('clients', 'transactions', 'invoices', 'subscriptions', 
                        'sync_runs', 'merge_conflicts', 'contact_identities', 
                        'system_settings', 'messages', 'client_events', 
                        'campaign_rules', 'campaign_executions', 'opt_outs')
    THEN '✅ REQUERIDA'
    ELSE '⚠️ OPCIONAL'
  END as estado
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_type = 'BASE TABLE'
ORDER BY 
  CASE 
    WHEN table_name IN ('clients', 'transactions', 'invoices', 'subscriptions', 
                        'sync_runs', 'merge_conflicts', 'contact_identities', 
                        'system_settings')
    THEN 1
    ELSE 2
  END,
  table_name;

-- 2. VERIFICAR FUNCIONES RPC
SELECT 
  'FUNCIONES RPC' as tipo,
  routine_name as nombre,
  CASE 
    WHEN routine_name IN ('is_admin', 'normalize_email', 'normalize_phone_e164', 
                          'merge_contact', 'unify_identity')
    THEN '✅ REQUERIDA'
    ELSE '⚠️ OPCIONAL'
  END as estado
FROM information_schema.routines 
WHERE routine_schema = 'public' 
AND routine_type = 'FUNCTION'
ORDER BY 
  CASE 
    WHEN routine_name IN ('is_admin', 'normalize_email', 'normalize_phone_e164', 
                          'merge_contact', 'unify_identity')
    THEN 1
    ELSE 2
  END,
  routine_name;

-- 3. VERIFICAR COLUMNAS CRÍTICAS EN CLIENTS
SELECT 
  'COLUMNAS CLIENTS' as tipo,
  column_name as nombre,
  data_type as tipo_dato,
  CASE 
    WHEN column_name IN ('id', 'email', 'full_name', 'phone', 'lifecycle_stage', 
                         'payment_status', 'converted_at', 'total_paid', 
                         'stripe_customer_id', 'last_sync')
    THEN '✅ REQUERIDA'
    ELSE '⚠️ OPCIONAL'
  END as estado
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name = 'clients'
ORDER BY 
  CASE 
    WHEN column_name IN ('id', 'email', 'full_name', 'phone', 'lifecycle_stage', 
                         'payment_status', 'converted_at', 'total_paid', 
                         'stripe_customer_id', 'last_sync')
    THEN 1
    ELSE 2
  END,
  column_name;

-- 4. VERIFICAR COLUMNAS CRÍTICAS EN TRANSACTIONS
SELECT 
  'COLUMNAS TRANSACTIONS' as tipo,
  column_name as nombre,
  data_type as tipo_dato,
  CASE 
    WHEN column_name IN ('id', 'client_id', 'amount', 'currency', 'status', 
                         'source', 'payment_key', 'external_transaction_id', 
                         'customer_email', 'stripe_payment_intent_id')
    THEN '✅ REQUERIDA'
    ELSE '⚠️ OPCIONAL'
  END as estado
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name = 'transactions'
ORDER BY 
  CASE 
    WHEN column_name IN ('id', 'client_id', 'amount', 'currency', 'status', 
                         'source', 'payment_key', 'external_transaction_id', 
                         'customer_email', 'stripe_payment_intent_id')
    THEN 1
    ELSE 2
  END,
  column_name;

-- 5. VERIFICAR ÍNDICES CRÍTICOS
SELECT 
  'ÍNDICES' as tipo,
  indexname as nombre,
  tablename as tabla,
  CASE 
    WHEN indexname LIKE '%email%' OR indexname LIKE '%client_id%' 
         OR indexname LIKE '%status%' OR indexname LIKE '%source%'
    THEN '✅ IMPORTANTE'
    ELSE '⚠️ OPCIONAL'
  END as estado
FROM pg_indexes 
WHERE schemaname = 'public'
AND tablename IN ('clients', 'transactions', 'invoices', 'subscriptions', 
                  'sync_runs', 'contact_identities', 'merge_conflicts')
ORDER BY tablename, indexname;

-- 6. RESUMEN DE ESTADO
SELECT 
  'RESUMEN' as tipo,
  'Tablas principales' as categoria,
  COUNT(*)::text as cantidad,
  CASE 
    WHEN COUNT(*) >= 8 THEN '✅ COMPLETO'
    ELSE '⚠️ FALTANTES'
  END as estado
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('clients', 'transactions', 'invoices', 'subscriptions', 
                   'sync_runs', 'merge_conflicts', 'contact_identities', 
                   'system_settings')

UNION ALL

SELECT 
  'RESUMEN' as tipo,
  'Funciones RPC' as categoria,
  COUNT(*)::text as cantidad,
  CASE 
    WHEN COUNT(*) >= 5 THEN '✅ COMPLETO'
    ELSE '⚠️ FALTANTES'
  END as estado
FROM information_schema.routines 
WHERE routine_schema = 'public' 
AND routine_name IN ('is_admin', 'normalize_email', 'normalize_phone_e164', 
                      'merge_contact', 'unify_identity');
