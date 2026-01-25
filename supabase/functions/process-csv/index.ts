import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import Papa from "https://deno.land/x/papaparse@v5.4.1/papaparse.min.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AdminVerifyResult {
  valid: boolean;
  error?: string;
  userEmail?: string;
}

interface ProcessCsvRequest {
  fileType?: string;
  csvText?: string;
  storageBucket?: string;
  storagePath?: string;
  cursor?: number;
  limit?: number;
  syncRunId?: string | null;
  fileName?: string;
}

interface ProcessCsvResponse {
  success: boolean;
  syncRunId?: string | null;
  hasMore?: boolean;
  nextCursor?: number | null;
  stats?: Record<string, number>;
  duration_ms?: number;
  error?: string;
}

const FILE_TYPES = [
  'web',
  'stripe',
  'paypal',
  'subscriptions',
  'stripe_customers',
  'stripe_payments',
  'ghl',
];

async function verifyAdmin(req: Request): Promise<AdminVerifyResult> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { valid: false, error: 'Invalid or expired token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'User is not an admin' };
  }

  return { valid: true, userEmail: user.email ?? undefined };
}

const normalizeKey = (key: string) => key
  .toLowerCase()
  .replace(/\uFEFF/g, '')
  .replace(/\s+/g, ' ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const normalizeRow = (row: Record<string, string>): Record<string, string> => {
  const normalized: Record<string, string> = {};
  Object.entries(row).forEach(([key, value]) => {
    normalized[normalizeKey(key)] = value;
  });
  return normalized;
};

const detectFileType = (headers: string[], fileName?: string): string => {
  const headerLine = headers.join(',').toLowerCase();

  if (headerLine.includes('total_spend') || headerLine.includes('total spend') || headerLine.includes('lifetime value')) {
    return 'stripe_customers';
  }
  if (headerLine.includes('amount_refunded') || headerLine.includes('amount refunded') || headerLine.includes('customer email')) {
    return 'stripe_payments';
  }
  if (headerLine.includes('transaction id') || headerLine.includes('id. de transaccion') || headerLine.includes('id. de transacción')) {
    return 'paypal';
  }
  if (headerLine.includes('subscription') || headerLine.includes('plan name') || headerLine.includes('plan_name')) {
    return 'subscriptions';
  }
  if (headerLine.includes('payment_intent') || headerLine.includes('created_utc')) {
    return 'stripe';
  }
  if (headerLine.includes('contactid') || headerLine.includes('gohighlevel') || headerLine.includes('ghl')) {
    return 'ghl';
  }

  if (fileName) {
    const lower = fileName.toLowerCase();
    if (lower.includes('unified_customers')) return 'stripe_customers';
    if (lower.includes('unified_payments')) return 'stripe_payments';
    if (lower.includes('paypal')) return 'paypal';
    if (lower.includes('subscription')) return 'subscriptions';
    if (lower.includes('stripe')) return 'stripe';
  }

  return 'web';
};

const parseAmountToCents = (raw: string | undefined): number => {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  const value = Number(cleaned);
  if (Number.isNaN(value)) return 0;
  return Math.round(value * 100);
};

const toIsoDate = (raw?: string): string | null => {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ success: false, error: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json() as ProcessCsvRequest;
    const cursor = body.cursor ?? 0;
    const limit = body.limit && body.limit > 0 ? Math.min(body.limit, 1000) : 500;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let csvText = body.csvText;
    if (!csvText && body.storageBucket && body.storagePath) {
      const { data: fileData, error } = await supabase.storage
        .from(body.storageBucket)
        .download(body.storagePath);
      if (error) {
        throw new Error(`Storage download failed: ${error.message}`);
      }
      csvText = await fileData.text();
    }

    if (!csvText) {
      return new Response(
        JSON.stringify({ success: false, error: 'csvText or storagePath required' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    const rawRows = parsed.data || [];
    const headers = Object.keys(rawRows[0] || {});
    const fileType = FILE_TYPES.includes(body.fileType || '')
      ? body.fileType!
      : detectFileType(headers, body.fileName);

    const totalRows = rawRows.length;
    const batchRows = rawRows.slice(cursor, cursor + limit);

    const stats: Record<string, number> = {
      totalRows,
      processed: batchRows.length,
      clientsCreated: 0,
      clientsUpdated: 0,
      transactionsCreated: 0,
      transactionsSkipped: 0,
      subscriptionsUpserted: 0,
    };

    const nowIso = new Date().toISOString();

    const clients: Array<Record<string, unknown>> = [];
    const transactions: Array<Record<string, unknown>> = [];
    const subscriptions: Array<Record<string, unknown>> = [];

    for (const row of batchRows) {
      const normalized = normalizeRow(row);
      const unmapped = Object.entries(row).reduce<Record<string, string>>((acc, [key, value]) => {
        const norm = normalizeKey(key);
        if (!normalized[norm]) {
          acc[key] = value;
        }
        return acc;
      }, {});

      if (fileType === 'web' || fileType === 'ghl') {
        const email = normalized.email || normalized.correo || normalized.mail;
        if (!email) continue;
        clients.push({
          email: String(email).toLowerCase(),
          full_name: normalized.full_name || normalized.name || normalized.nombre || null,
          phone: normalized.phone || normalized.telefono || normalized.phone_number || null,
          lifecycle_stage: 'LEAD',
          last_sync: nowIso,
          customer_metadata: Object.keys(unmapped).length > 0 ? { csv_raw: unmapped } : null,
        });
      }

      if (fileType === 'stripe_customers') {
        const email = normalized.email || normalized.customer_email;
        if (!email) continue;
        clients.push({
          email: String(email).toLowerCase(),
          full_name: normalized.name || normalized.customer_name || null,
          total_spend: parseAmountToCents(normalized.total_spend || normalized.total_spend_usd || normalized.totalspend),
          lifecycle_stage: normalized.delinquent === 'true' ? 'CHURN' : 'CUSTOMER',
          last_sync: nowIso,
          customer_metadata: Object.keys(unmapped).length > 0 ? { csv_raw: unmapped } : null,
        });
      }

      if (fileType === 'subscriptions') {
        const email = normalized.customer_email || normalized.email;
        const subId = normalized.subscription_id || normalized.id || normalized.subscription;
        subscriptions.push({
          stripe_subscription_id: subId || crypto.randomUUID(),
          customer_email: email ? String(email).toLowerCase() : null,
          plan_name: normalized.plan_name || normalized.plan || normalized.product_name || null,
          amount: parseAmountToCents(normalized.amount || normalized.price || normalized.price_cents),
          currency: (normalized.currency || 'usd').toLowerCase(),
          interval: normalized.interval || normalized.frequency || 'month',
          status: normalized.status || 'active',
          provider: 'csv',
          trial_start: toIsoDate(normalized.trial_start),
          trial_end: toIsoDate(normalized.trial_end),
          current_period_start: toIsoDate(normalized.current_period_start),
          current_period_end: toIsoDate(normalized.current_period_end),
          updated_at: nowIso,
          raw_data: row,
        });
      }

      if (fileType === 'stripe' || fileType === 'stripe_payments' || fileType === 'paypal') {
        const email = normalized.customer_email || normalized.email || normalized.payer_email || normalized.payer_email_address;
        if (!email) continue;

        const transactionId = normalized.transaction_id || normalized.id || normalized.payment_intent || normalized.charge_id;
        const amount = fileType === 'stripe_payments'
          ? parseAmountToCents(normalized.amount)
          : parseAmountToCents(normalized.gross || normalized.amount || normalized.net);

        const currency = (normalized.currency || normalized.currency_code || 'usd').toLowerCase();
        const statusRaw = normalized.status || normalized.transaction_status || normalized.payment_status || '';
        const statusLower = String(statusRaw).toLowerCase();
        const status = statusLower.includes('succeed') || statusLower.includes('paid') || statusLower.includes('complete')
          ? 'paid'
          : statusLower.includes('fail') || statusLower.includes('denied') || statusLower.includes('refunded')
            ? 'failed'
            : 'pending';

        transactions.push({
          stripe_payment_intent_id: transactionId || crypto.randomUUID(),
          payment_key: transactionId || crypto.randomUUID(),
          external_transaction_id: transactionId || null,
          amount,
          currency,
          status,
          customer_email: String(email).toLowerCase(),
          stripe_created_at: toIsoDate(normalized.created || normalized.created_utc || normalized.transaction_initiation_date) || nowIso,
          source: fileType === 'paypal' ? 'paypal_csv' : 'stripe_csv',
          metadata: Object.keys(unmapped).length > 0 ? { csv_raw: unmapped } : null,
          raw_data: row,
        });

        clients.push({
          email: String(email).toLowerCase(),
          full_name: normalized.customer_name || normalized.name || null,
          lifecycle_stage: status === 'paid' ? 'CUSTOMER' : 'LEAD',
          last_sync: nowIso,
        });
      }
    }

    if (clients.length > 0) {
      const { data } = await supabase
        .from('clients')
        .upsert(clients, { onConflict: 'email', ignoreDuplicates: false })
        .select('id');
      stats.clientsUpdated += data?.length || 0;
    }

    if (transactions.length > 0) {
      const { data } = await supabase
        .from('transactions')
        .upsert(transactions, { onConflict: 'stripe_payment_intent_id', ignoreDuplicates: false })
        .select('id');
      stats.transactionsCreated += data?.length || 0;
    }

    if (subscriptions.length > 0) {
      const { data } = await supabase
        .from('subscriptions')
        .upsert(subscriptions, { onConflict: 'stripe_subscription_id', ignoreDuplicates: false })
        .select('id');
      stats.subscriptionsUpserted += data?.length || 0;
    }

    let syncRunId = body.syncRunId;
    if (!syncRunId) {
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .insert({
          source: 'csv_import',
          status: 'running',
          metadata: {
            fileType,
            fileName: body.fileName,
            totalRows,
            initiatedBy: authCheck.userEmail,
          },
        })
        .select('id')
        .single();
      syncRunId = syncRun?.id ?? null;
    }

    const hasMore = cursor + limit < totalRows;
    const nextCursor = hasMore ? cursor + limit : null;

    if (syncRunId) {
      const { data: currentRun } = await supabase
        .from('sync_runs')
        .select('total_fetched, total_inserted')
        .eq('id', syncRunId)
        .single();

      const totalFetched = Math.min(totalRows, cursor + batchRows.length);
      const totalInserted = (currentRun?.total_inserted || 0) + (stats.transactionsCreated || 0) + (stats.subscriptionsUpserted || 0);

      await supabase
        .from('sync_runs')
        .update({
          status: hasMore ? 'continuing' : 'completed',
          completed_at: hasMore ? null : nowIso,
          checkpoint: hasMore ? { cursor: nextCursor } : null,
          total_fetched: totalFetched,
          total_inserted: totalInserted,
        })
        .eq('id', syncRunId);
    }

    const response: ProcessCsvResponse = {
      success: true,
      syncRunId,
      hasMore,
      nextCursor,
      stats,
      duration_ms: Date.now() - startTime,
    };

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage, duration_ms: Date.now() - startTime }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
