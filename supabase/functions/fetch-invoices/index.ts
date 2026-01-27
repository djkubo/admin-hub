import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Declare EdgeRuntime for background processing
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

// Auto-continuation: max pages per execution to avoid 60s timeout
const PAGES_PER_BATCH = 25;

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
  fetchAll?: boolean;
  _continuation?: boolean; // Internal flag for auto-continuation
}

interface FetchInvoicesResponse {
  success: boolean;
  synced: number;
  upserted: number;
  hasMore: boolean;
  nextCursor: string | null;
  syncRunId: string | null;
  status?: 'running' | 'continuing' | 'completed' | 'error';
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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

async function batchResolveClients(
  supabase: SupabaseClient,
  stripeCustomerIds: string[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(stripeCustomerIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const clientMap = new Map<string, string>();

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

// ============= INVOICE RECORD MAPPING =============

function mapInvoiceToRecord(
  invoice: StripeInvoice,
  clientsByStripeId: Map<string, string>,
  clientsByEmail: Map<string, string>
) {
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
}

// ============= SINGLE PAGE FETCH =============

interface FetchPageResult {
  invoices: StripeInvoice[];
  hasMore: boolean;
  nextCursor: string | null;
}

async function fetchSinglePage(
  stripeSecretKey: string,
  mode: string,
  startDate: string | null,
  endDate: string | null,
  cursor: string | null
): Promise<FetchPageResult> {
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
  // For 'full' mode, no date filter = all invoices
  if (cursor) {
    params.set('starting_after', cursor);
  }

  const stripeUrl = `https://api.stripe.com/v1/invoices?${params.toString()}`;
  
  const response = await fetch(stripeUrl, {
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
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

  return { invoices, hasMore, nextCursor };
}

// ============= BATCH UPSERT =============

async function batchUpsertInvoices(
  supabase: SupabaseClient,
  invoices: StripeInvoice[],
  clientsByStripeId: Map<string, string>,
  clientsByEmail: Map<string, string>
): Promise<number> {
  if (invoices.length === 0) return 0;

  const invoiceRecords = invoices.map(inv => 
    mapInvoiceToRecord(inv, clientsByStripeId, clientsByEmail)
  );

  const { error: upsertError, count } = await supabase
    .from("invoices")
    .upsert(invoiceRecords, { 
      onConflict: "stripe_invoice_id",
      ignoreDuplicates: false,
      count: 'exact'
    });

  if (upsertError) {
    console.error(`❌ Batch upsert error:`, upsertError.message);
    return 0;
  }

  return count || invoiceRecords.length;
}

// ============= AUTO-CONTINUATION HELPER =============

async function scheduleContinuation(
  syncRunId: string,
  mode: string,
  startDate: string | null,
  endDate: string | null,
  cursor: string
) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  
  console.log(`🔄 [Background] Scheduling continuation for cursor ${cursor.slice(0, 10)}...`);
  
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/fetch-invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        mode,
        fetchAll: true,
        syncRunId,
        cursor,
        startDate,
        endDate,
        _continuation: true
      })
    });
    
    if (!response.ok) {
      console.error(`❌ Continuation request failed: ${response.status}`);
    } else {
      console.log(`✅ Continuation scheduled successfully`);
    }
  } catch (error) {
    console.error(`❌ Continuation scheduling error:`, error);
  }
}

// ============= BACKGROUND FULL SYNC WITH AUTO-CONTINUATION =============

async function runFullInvoiceSync(
  supabase: SupabaseClient,
  stripeSecretKey: string,
  syncRunId: string,
  mode: string,
  startDate: string | null,
  endDate: string | null,
  initialCursor: string | null = null
) {
  console.log(`🚀 [Background] Starting batch: mode=${mode}, syncRunId=${syncRunId}, cursor=${initialCursor ? initialCursor.slice(0, 10) + '...' : 'start'}`);
  
  let cursor: string | null = initialCursor;
  let hasMore = true;
  let pageCount = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  const stats = { draft: 0, open: 0, paid: 0, void: 0, uncollectible: 0 };
  
  try {
    // Read existing progress from sync run (for continuation)
    const { data: currentRun } = await supabase
      .from('sync_runs')
      .select('total_fetched, total_inserted, metadata')
      .eq('id', syncRunId)
      .single();
    
    totalFetched = currentRun?.total_fetched || 0;
    totalInserted = currentRun?.total_inserted || 0;
    
    // Restore stats from metadata if continuing
    const existingStats = currentRun?.metadata?.stats;
    if (existingStats) {
      stats.draft = existingStats.draft || 0;
      stats.open = existingStats.open || 0;
      stats.paid = existingStats.paid || 0;
      stats.void = existingStats.void || 0;
      stats.uncollectible = existingStats.uncollectible || 0;
    }
    
    console.log(`📊 [Background] Resuming from: ${totalFetched} fetched, ${totalInserted} inserted`);
    
    while (hasMore && pageCount < PAGES_PER_BATCH) {
      pageCount++;
      const pageStart = Date.now();
      
      // Fetch page from Stripe
      const result = await fetchSinglePage(stripeSecretKey, mode, startDate, endDate, cursor);
      const invoices = result.invoices;
      
      console.log(`📄 [Background] Page ${pageCount}: ${invoices.length} invoices in ${Date.now() - pageStart}ms`);
      
      // Count stats
      for (const inv of invoices) {
        if (inv.status === 'draft') stats.draft++;
        else if (inv.status === 'open') stats.open++;
        else if (inv.status === 'paid') stats.paid++;
        else if (inv.status === 'void') stats.void++;
        else if (inv.status === 'uncollectible') stats.uncollectible++;
      }
      
      // Batch resolve clients
      const stripeCustomerIds: string[] = [];
      const emails: string[] = [];
      
      for (const invoice of invoices) {
        const customer = typeof invoice.customer === 'object' ? invoice.customer : null;
        const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : customer?.id || null;
        const customerEmail = invoice.customer_email || customer?.email || null;
        
        if (stripeCustomerId) stripeCustomerIds.push(stripeCustomerId);
        if (customerEmail) emails.push(customerEmail);
      }
      
      const clientsByStripeId = await batchResolveClients(supabase, stripeCustomerIds);
      const clientsByEmail = await batchResolveClientsByEmail(supabase, emails);
      
      // Batch upsert
      const upserted = await batchUpsertInvoices(supabase, invoices, clientsByStripeId, clientsByEmail);
      
      totalFetched += invoices.length;
      totalInserted += upserted;
      cursor = result.nextCursor;
      hasMore = result.hasMore && cursor !== null;
      
      // Update progress in sync_runs with lastActivity for stale detection
      await supabase.from('sync_runs').update({
        status: hasMore ? 'continuing' : 'completed',
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        checkpoint: hasMore ? { 
          cursor,
          lastActivity: new Date().toISOString() // Track activity for stale detection
        } : null,
        completed_at: hasMore ? null : new Date().toISOString(),
        metadata: { mode, startDate, endDate, stats, pageCount: (currentRun?.metadata?.pageCount || 0) + pageCount }
      }).eq('id', syncRunId);
      
      console.log(`📈 [Background] Progress: ${totalFetched} fetched, ${totalInserted} inserted`);
      
      // Rate limit delay between pages
      if (hasMore) await delay(100);
    }
    
    // ============= AUTO-CONTINUATION =============
    if (hasMore && cursor) {
      console.log(`🔄 [Background] Batch limit (${PAGES_PER_BATCH} pages) reached. Scheduling continuation...`);
      
      // Schedule next batch via self-invocation
      await scheduleContinuation(syncRunId, mode, startDate, endDate, cursor);
      
      console.log(`✅ [Background] Batch complete. Next batch will continue from cursor ${cursor.slice(0, 10)}...`);
    } else {
      console.log(`✅ [Background] Sync FULLY complete: ${totalFetched} fetched, ${totalInserted} inserted`);
      console.log(`📊 [Background] Final stats: draft=${stats.draft} open=${stats.open} paid=${stats.paid} void=${stats.void} uncollectible=${stats.uncollectible}`);
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ [Background] Sync error:`, errorMessage);
    
    await supabase.from('sync_runs').update({
      status: 'error',
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
      total_fetched: totalFetched,
      total_inserted: totalInserted,
    }).eq('id', syncRunId);
  }
}

// ============= MAIN HANDLER =============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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
    let fetchAll = false;
    let isContinuation = false;

    try {
      const body: FetchInvoicesRequest = await req.json();
      mode = body.mode || 'recent';
      cursor = body.cursor || null;
      syncRunId = body.syncRunId || null;
      fetchAll = body.fetchAll === true;
      isContinuation = body._continuation === true;
      
      if (body.startDate) startDate = body.startDate;
      if (body.endDate) endDate = body.endDate;
    } catch {
      // Default to recent mode
    }

    console.log(`🧾 fetch-invoices: mode=${mode}, fetchAll=${fetchAll}, continuation=${isContinuation}, cursor=${cursor ? cursor.slice(0, 10) + '...' : 'null'}, syncRunId=${syncRunId || 'new'}`);

    // ============= HANDLE CONTINUATION REQUESTS =============
    if (isContinuation && syncRunId && cursor) {
      console.log(`🔄 Processing continuation for sync ${syncRunId}`);
      
      EdgeRuntime.waitUntil(
        runFullInvoiceSync(supabase, STRIPE_SECRET_KEY, syncRunId, mode, startDate, endDate, cursor)
      );
      
      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          syncRunId,
          synced: 0,
          upserted: 0,
          hasMore: true,
          nextCursor: null,
          message: 'Continuation batch started'
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============= SECURITY: Verify JWT + admin role (skip for internal continuations) =============
    if (!isContinuation) {
      const authCheck = await verifyAdmin(req);
      if (!authCheck.valid) {
        console.error("❌ Auth failed:", authCheck.error);
        return new Response(
          JSON.stringify({ success: false, error: "Forbidden", message: authCheck.error }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("✅ Admin verified");
    }

    // Check for existing running sync (avoid duplicates)
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    
    const { data: existingSync } = await supabase
      .from('sync_runs')
      .select('id, started_at, total_fetched, checkpoint')
      .eq('source', 'stripe_invoices')
      .in('status', ['running', 'continuing'])
      .gte('started_at', threeMinutesAgo)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (existingSync && !syncRunId) {
      console.log('⚠️ Sync already running (last 3min):', existingSync.id);
      return new Response(
        JSON.stringify({
          success: true,
          status: 'running',
          syncRunId: existingSync.id,
          synced: existingSync.total_fetched || 0,
          upserted: 0,
          hasMore: true,
          nextCursor: null,
          message: 'Sync already in progress',
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
      .lt('started_at', threeMinutesAgo);
    
    // Create new sync run
    const { data: syncRun } = await supabase
      .from('sync_runs')
      .insert({
        source: 'stripe_invoices',
        status: 'running',
        total_fetched: 0,
        total_inserted: 0,
        metadata: { mode, startDate, endDate, fetchAll }
      })
      .select('id')
      .single();
    syncRunId = syncRun?.id || null;
    
    console.log('🆕 Created new sync run:', syncRunId);

    // ============= BACKGROUND MODE (fetchAll=true) =============
    if (fetchAll && syncRunId) {
      console.log('🚀 Starting background processing with EdgeRuntime.waitUntil()');
      
      EdgeRuntime.waitUntil(
        runFullInvoiceSync(supabase, STRIPE_SECRET_KEY, syncRunId, mode, startDate, endDate, null)
      );
      
      // Return immediately with running status
      return new Response(
        JSON.stringify({
          success: true,
          status: 'running',
          syncRunId,
          synced: 0,
          upserted: 0,
          hasMore: true,
          nextCursor: null,
          message: 'Sync started in background'
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============= SINGLE PAGE MODE (original behavior) =============
    console.log('🌐 Fetching single page from Stripe...');
    const fetchStart = Date.now();
    
    const result = await fetchSinglePage(STRIPE_SECRET_KEY, mode, startDate, endDate, cursor);
    const invoices = result.invoices;
    const hasMore = result.hasMore;
    const nextCursor = result.nextCursor;

    console.log(`📄 Fetched ${invoices.length} invoices in ${Date.now() - fetchStart}ms, hasMore: ${hasMore}`);

    // Stats counters
    const stats = { draft: 0, open: 0, paid: 0, void: 0, uncollectible: 0 };

    // Collect all stripe_customer_ids and emails for batch lookup
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

    // Batch resolve clients
    const clientsByStripeId = await batchResolveClients(supabase, stripeCustomerIds);
    const clientsByEmail = await batchResolveClientsByEmail(supabase, emails);

    // Batch upsert
    const upsertedCount = await batchUpsertInvoices(supabase, invoices, clientsByStripeId, clientsByEmail);

    // Update sync run with incremental counters
    if (syncRunId) {
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

    const responseData: FetchInvoicesResponse = {
      success: true,
      synced: invoices.length,
      upserted: upsertedCount,
      hasMore,
      nextCursor,
      syncRunId,
      stats,
    };

    return new Response(
      JSON.stringify(responseData),
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
