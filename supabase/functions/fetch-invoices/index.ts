import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============= TYPES =============

interface AdminVerifyResult {
  valid: boolean;
  error?: string;
  userId?: string;
}

interface FetchInvoicesRequest {
  mode?: 'full' | 'range' | 'recent';
  startDate?: string;
  endDate?: string;
  cursor?: string;
  syncRunId?: string;
}

interface FetchInvoicesResponse {
  success: boolean;
  synced: number;
  upserted: number;
  hasMore: boolean;
  nextCursor: string | null;
  syncRunId: string | null;
  error?: string;
  stats?: {
    draft: number;
    open: number;
    paid: number;
    void: number;
    uncollectible: number;
  };
}

interface StripeLineItem {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  quantity: number;
  price?: {
    id: string;
    nickname: string | null;
    unit_amount: number | null;
    recurring?: { interval: string; interval_count: number } | null;
    product?: string | { id: string; name: string };
  };
}

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
}

interface StripeInvoice {
  id: string;
  number: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer: string | StripeCustomer;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  subtotal: number;
  total: number;
  currency: string;
  status: string;
  created: number;
  period_end: number;
  next_payment_attempt: number | null;
  due_date: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  attempt_count: number;
  billing_reason: string | null;
  collection_method: string | null;
  description: string | null;
  payment_intent: string | { id: string } | null;
  charge: string | null;
  default_payment_method: string | { id: string } | null;
  last_finalization_error: { message: string; code: string } | null;
  finalized_at: number | null;
  automatically_finalizes_at: number | null;
  status_transitions?: {
    finalized_at?: number | null;
    paid_at?: number | null;
    marked_uncollectible_at?: number | null;
    voided_at?: number | null;
  };
  subscription?: {
    id: string;
    status: string;
    items?: {
      data: Array<{
        price?: {
          id: string;
          nickname: string | null;
          recurring?: { interval: string } | null;
          product?: string | { id: string; name: string };
        };
      }>;
    };
  } | string | null;
  lines?: { data: StripeLineItem[]; has_more?: boolean };
}

// ============= SECURITY =============

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

  return { valid: true, userId: user.id };
}

// ============= HELPERS =============

function extractPlanInfo(invoice: StripeInvoice): { planName: string | null; planInterval: string | null; productName: string | null } {
  let planName: string | null = null;
  let planInterval: string | null = null;
  let productName: string | null = null;

  // Try from subscription first
  if (invoice.subscription && typeof invoice.subscription === 'object') {
    const sub = invoice.subscription;
    if (sub.items?.data?.[0]?.price) {
      const price = sub.items.data[0].price;
      planName = price.nickname || null;
      planInterval = price.recurring?.interval || null;
      if (price.product && typeof price.product === 'object') {
        productName = price.product.name;
      }
    }
  }

  // Fallback: invoice lines
  if (!planName && invoice.lines?.data?.length) {
    const firstLine = invoice.lines.data[0];
    if (firstLine.price) {
      planName = firstLine.price.nickname || firstLine.description || null;
      planInterval = firstLine.price.recurring?.interval || null;
      if (firstLine.price.product && typeof firstLine.price.product === 'object') {
        productName = firstLine.price.product.name;
      }
    } else if (firstLine.description) {
      planName = firstLine.description;
    }
  }

  // Format interval to Spanish
  if (planInterval) {
    const intervalMap: Record<string, string> = {
      'day': 'Diario',
      'week': 'Semanal',
      'month': 'Mensual',
      'year': 'Anual',
    };
    planInterval = intervalMap[planInterval] || planInterval;
  }

  return { planName, planInterval, productName };
}

// ============= BATCH CLIENT RESOLUTION =============

interface ClientLookupResult {
  stripeCustomerId: string;
  clientId: string | null;
}

/**
 * Batch resolve client IDs for multiple Stripe customer IDs
 * This is MUCH faster than individual queries - 1 query instead of 100
 */
async function batchResolveClients(
  supabase: SupabaseClient,
  stripeCustomerIds: string[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(stripeCustomerIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const clientMap = new Map<string, string>();

  // Single query to get all client mappings by stripe_customer_id
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, stripe_customer_id')
    .in('stripe_customer_id', uniqueIds);

  if (error) {
    console.warn('Batch client lookup error:', error.message);
    return clientMap;
  }

  for (const client of clients || []) {
    if (client.stripe_customer_id) {
      clientMap.set(client.stripe_customer_id, client.id);
    }
  }

  console.log(`🔗 Resolved ${clientMap.size}/${uniqueIds.length} clients via stripe_customer_id`);
  return clientMap;
}

/**
 * Secondary batch lookup by email for invoices without stripe_customer_id match
 */
async function batchResolveClientsByEmail(
  supabase: SupabaseClient,
  emails: string[]
): Promise<Map<string, string>> {
  const uniqueEmails = [...new Set(emails.filter(Boolean).map(e => e.toLowerCase()))];
  if (uniqueEmails.length === 0) return new Map();

  const clientMap = new Map<string, string>();

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, email')
    .in('email', uniqueEmails);

  if (error) {
    console.warn('Batch email lookup error:', error.message);
    return clientMap;
  }

  for (const client of clients || []) {
    if (client.email) {
      clientMap.set(client.email.toLowerCase(), client.id);
    }
  }

  console.log(`📧 Resolved ${clientMap.size}/${uniqueEmails.length} clients via email`);
  return clientMap;
}

// ============= MAIN HANDLER =============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify JWT + admin role
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ success: false, error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Admin verified");

    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request
    let mode: 'full' | 'range' | 'recent' = 'recent';
    let startDate: string | null = null;
    let endDate: string | null = null;
    let cursor: string | null = null;
    let syncRunId: string | null = null;

    try {
      const body: FetchInvoicesRequest = await req.json();
      mode = body.mode || 'recent';
      cursor = body.cursor || null;
      syncRunId = body.syncRunId || null;
      
      if (body.startDate) startDate = body.startDate;
      if (body.endDate) endDate = body.endDate;
    } catch {
      // Default to recent mode
    }

    console.log(`🧾 fetch-invoices: mode=${mode}, cursor=${cursor ? cursor.slice(0, 10) + '...' : 'null'}, syncRunId=${syncRunId || 'new'}`);

    // SKIP duplicate check if we already have a syncRunId (continuing pagination)
    if (!syncRunId) {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
      
      const { data: existingSync } = await supabase
        .from('sync_runs')
        .select('id, started_at, total_fetched, checkpoint')
        .eq('source', 'stripe_invoices')
        .eq('status', 'running')
        .gte('started_at', oneMinuteAgo)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (existingSync) {
        console.log('⚠️ Sync already running (last 60s):', existingSync.id);
        return new Response(
          JSON.stringify({
            success: false,
            error: 'sync_already_running',
            existingSyncId: existingSync.id,
            syncRunId: existingSync.id,
            message: 'A sync is already in progress. Please wait.',
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      // Cancel any old stuck syncs before creating new one
      await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled by new sync request' 
        })
        .eq('source', 'stripe_invoices')
        .in('status', ['running', 'continuing'])
        .lt('started_at', oneMinuteAgo);
      
      // Create new sync run
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .insert({
          source: 'stripe_invoices',
          status: 'running',
          total_fetched: 0,
          total_inserted: 0,
          metadata: { mode, startDate, endDate }
        })
        .select('id')
        .single();
      syncRunId = syncRun?.id || null;
      
      console.log('🆕 Created new sync run:', syncRunId);
    } else {
      // Just log that we're continuing - no need to update status here
      console.log('📎 Continuing sync run:', syncRunId);
    }

    // Build Stripe API URL
    const params = new URLSearchParams();
    params.set('limit', '100');
    params.set('expand[]', 'data.subscription');
    params.append('expand[]', 'data.lines.data.price');
    params.append('expand[]', 'data.customer');

    if (mode === 'range' && startDate) {
      params.set('created[gte]', String(Math.floor(new Date(startDate).getTime() / 1000)));
    }
    if (mode === 'range' && endDate) {
      params.set('created[lte]', String(Math.floor(new Date(endDate).getTime() / 1000)));
    }
    if (mode === 'recent') {
      const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
      params.set('created[gte]', String(ninetyDaysAgo));
    }
    if (cursor) {
      params.set('starting_after', cursor);
    }

    const stripeUrl = `https://api.stripe.com/v1/invoices?${params.toString()}`;
    
    console.log('🌐 Fetching from Stripe...');
    const fetchStart = Date.now();
    
    const response = await fetch(stripeUrl, {
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Stripe API error: ${error}`);
    }

    const stripeData = await response.json();
    const invoices: StripeInvoice[] = stripeData.data || [];
    const hasMore = stripeData.has_more || false;
    const nextCursor = hasMore && invoices.length > 0 ? invoices[invoices.length - 1].id : null;

    console.log(`📄 Fetched ${invoices.length} invoices in ${Date.now() - fetchStart}ms, hasMore: ${hasMore}`);

    // ============= BATCH PROCESSING (FAST) =============
    const processStart = Date.now();
    
    // Stats counters
    const stats = { draft: 0, open: 0, paid: 0, void: 0, uncollectible: 0 };

    // Step 1: Collect all stripe_customer_ids and emails for batch lookup
    const stripeCustomerIds: string[] = [];
    const emails: string[] = [];
    
    for (const invoice of invoices) {
      const customer = typeof invoice.customer === 'object' ? invoice.customer : null;
      const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : customer?.id || null;
      const customerEmail = invoice.customer_email || customer?.email || null;
      
      if (stripeCustomerId) stripeCustomerIds.push(stripeCustomerId);
      if (customerEmail) emails.push(customerEmail);
      
      // Count stats
      if (invoice.status === 'draft') stats.draft++;
      else if (invoice.status === 'open') stats.open++;
      else if (invoice.status === 'paid') stats.paid++;
      else if (invoice.status === 'void') stats.void++;
      else if (invoice.status === 'uncollectible') stats.uncollectible++;
    }

    // Step 2: Batch resolve clients (2 queries total instead of 200+)
    const clientsByStripeId = await batchResolveClients(supabase, stripeCustomerIds);
    const clientsByEmail = await batchResolveClientsByEmail(supabase, emails);

    // Step 3: Map all invoices to records (in memory, no queries)
    const invoiceRecords = invoices.map(invoice => {
      const customer = typeof invoice.customer === 'object' ? invoice.customer : null;
      const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : customer?.id || null;
      const customerEmail = invoice.customer_email || customer?.email || null;
      const customerName = invoice.customer_name || customer?.name || null;
      const customerPhone = customer?.phone || null;

      // Resolve client_id: first by stripe_customer_id, then by email
      let clientId: string | null = null;
      if (stripeCustomerId && clientsByStripeId.has(stripeCustomerId)) {
        clientId = clientsByStripeId.get(stripeCustomerId)!;
      } else if (customerEmail && clientsByEmail.has(customerEmail.toLowerCase())) {
        clientId = clientsByEmail.get(customerEmail.toLowerCase())!;
      }

      const { planName, planInterval, productName } = extractPlanInfo(invoice);
      
      const subscriptionId = invoice.subscription 
        ? (typeof invoice.subscription === 'object' ? invoice.subscription.id : invoice.subscription)
        : null;

      const paymentIntentId = invoice.payment_intent
        ? (typeof invoice.payment_intent === 'object' ? invoice.payment_intent.id : invoice.payment_intent)
        : null;

      const defaultPaymentMethod = invoice.default_payment_method
        ? (typeof invoice.default_payment_method === 'object' ? invoice.default_payment_method.id : invoice.default_payment_method)
        : null;

      const lineItems = invoice.lines?.data?.map(line => ({
        id: line.id,
        amount: line.amount,
        currency: line.currency,
        description: line.description,
        quantity: line.quantity,
        price_id: line.price?.id,
        price_nickname: line.price?.nickname,
        unit_amount: line.price?.unit_amount,
        interval: line.price?.recurring?.interval,
        product_name: line.price?.product && typeof line.price.product === 'object' 
          ? line.price.product.name 
          : null,
      })) || null;

      const paidAt = invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
        : (invoice.status === 'paid' ? new Date().toISOString() : null);
      
      const finalizedAt = invoice.status_transitions?.finalized_at
        ? new Date(invoice.status_transitions.finalized_at * 1000).toISOString()
        : (invoice.finalized_at ? new Date(invoice.finalized_at * 1000).toISOString() : null);

      return {
        stripe_invoice_id: invoice.id,
        invoice_number: invoice.number,
        customer_email: customerEmail?.toLowerCase() || null,
        customer_name: customerName,
        customer_phone: customerPhone,
        stripe_customer_id: stripeCustomerId,
        client_id: clientId,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid,
        amount_remaining: invoice.amount_remaining,
        subtotal: invoice.subtotal,
        total: invoice.total,
        currency: invoice.currency,
        status: invoice.status,
        stripe_created_at: invoice.created 
          ? new Date(invoice.created * 1000).toISOString() 
          : null,
        finalized_at: finalizedAt,
        paid_at: paidAt,
        automatically_finalizes_at: invoice.automatically_finalizes_at 
          ? new Date(invoice.automatically_finalizes_at * 1000).toISOString() 
          : null,
        period_end: invoice.period_end 
          ? new Date(invoice.period_end * 1000).toISOString() 
          : null,
        next_payment_attempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : null,
        due_date: invoice.due_date
          ? new Date(invoice.due_date * 1000).toISOString()
          : null,
        hosted_invoice_url: invoice.hosted_invoice_url,
        pdf_url: invoice.invoice_pdf,
        subscription_id: subscriptionId,
        plan_name: planName,
        plan_interval: planInterval,
        product_name: productName,
        attempt_count: invoice.attempt_count || 0,
        billing_reason: invoice.billing_reason,
        collection_method: invoice.collection_method,
        description: invoice.description,
        payment_intent_id: paymentIntentId,
        charge_id: invoice.charge,
        default_payment_method: defaultPaymentMethod,
        last_finalization_error: invoice.last_finalization_error?.message || null,
        lines: lineItems,
        raw_data: invoice as unknown as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      };
    });

    // Step 4: Single BATCH UPSERT (1 query instead of 100)
    console.log(`💾 Batch upserting ${invoiceRecords.length} invoices...`);
    const upsertStart = Date.now();
    
    const { error: upsertError, count } = await supabase
      .from("invoices")
      .upsert(invoiceRecords, { 
        onConflict: "stripe_invoice_id",
        ignoreDuplicates: false,
        count: 'exact'
      });

    const upsertedCount = upsertError ? 0 : (count || invoiceRecords.length);
    
    if (upsertError) {
      console.error(`❌ Batch upsert error:`, upsertError.message);
    } else {
      console.log(`✅ Batch upsert complete: ${upsertedCount} records in ${Date.now() - upsertStart}ms`);
    }

    console.log(`⏱️ Total processing: ${Date.now() - processStart}ms`);

    // Step 5: Update sync run with INCREMENTAL counters
    if (syncRunId) {
      // First, read current counters
      const { data: currentRun } = await supabase
        .from('sync_runs')
        .select('total_fetched, total_inserted')
        .eq('id', syncRunId)
        .single();
      
      const currentFetched = currentRun?.total_fetched || 0;
      const currentInserted = currentRun?.total_inserted || 0;
      
      const newTotalFetched = currentFetched + invoices.length;
      const newTotalInserted = currentInserted + upsertedCount;
      
      await supabase
        .from('sync_runs')
        .update({
          status: hasMore ? 'continuing' : 'completed',
          total_fetched: newTotalFetched,
          total_inserted: newTotalInserted,
          checkpoint: hasMore ? { cursor: nextCursor } : null,
          completed_at: hasMore ? null : new Date().toISOString(),
        })
        .eq('id', syncRunId);
      
      console.log(`📈 Sync progress: ${currentFetched}+${invoices.length}=${newTotalFetched} fetched, ${currentInserted}+${upsertedCount}=${newTotalInserted} inserted`);
    }

    console.log(`✅ Page complete | Stats: draft=${stats.draft} open=${stats.open} paid=${stats.paid} void=${stats.void}`);

    const result: FetchInvoicesResponse = {
      success: true,
      synced: invoices.length,
      upserted: upsertedCount,
      hasMore,
      nextCursor,
      syncRunId,
      stats,
    };

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Fatal error:", errorMessage);
    
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
