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
  startDate?: string;
  endDate?: string;
  fetchAll?: boolean;
  cursor?: string;
  limit?: number;
  syncRunId?: string;
}

interface FetchInvoicesResponse {
  success: boolean;
  synced: number;
  upserted: number;
  hasMore: boolean;
  nextCursor: string | null;
  syncRunId: string | null;
  duration_ms: number;
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
  customer_details?: {
    email?: string | null;
    name?: string | null;
    phone?: string | null;
  };
  metadata?: Record<string, string>;
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

// Resolve client via unify_identity RPC and enrich client data
async function resolveClientViaUnify(
  supabase: SupabaseClient,
  stripeCustomerId: string | null,
  email: string | null,
  phone: string | null,
  fullName: string | null
): Promise<{ clientId: string | null; shouldEnrich: boolean }> {
  if (!stripeCustomerId && !email && !phone) {
    return { clientId: null, shouldEnrich: false };
  }

  try {
    const { data, error } = await supabase.rpc('unify_identity', {
      p_source: 'stripe',
      p_stripe_customer_id: stripeCustomerId,
      p_email: email?.toLowerCase() || null,
      p_phone: phone,
      p_full_name: fullName,
    });

    if (error) {
      console.warn('unify_identity error:', error.message);
      return { clientId: null, shouldEnrich: false };
    }

    if (data?.success && data?.client_id) {
      // Check if this was a new client or an update that might need enrichment
      const action = data?.action || 'unknown';
      const shouldEnrich = action === 'created' || action === 'matched' || action === 'merged';
      return { clientId: data.client_id, shouldEnrich };
    }
  } catch (e) {
    console.warn('unify_identity failed:', e);
  }

  return { clientId: null, shouldEnrich: false };
}

// Enrich client data if name or phone are missing
async function enrichClientIfNeeded(
  supabase: SupabaseClient,
  clientId: string,
  customerName: string | null,
  customerPhone: string | null,
  stripeCustomerId: string | null
): Promise<void> {
  if (!clientId) return;

  try {
    // Fetch current client data
    const { data: client, error: fetchError } = await supabase
      .from('clients')
      .select('full_name, phone_e164, stripe_customer_id')
      .eq('id', clientId)
      .single();

    if (fetchError || !client) return;

    // Build update object only with missing fields
    const updates: Record<string, unknown> = {};

    // Enrich full_name if missing and we have it from Stripe
    if (!client.full_name && customerName) {
      updates.full_name = customerName;
    }

    // Enrich phone_e164 if missing and we have it from Stripe
    if (!client.phone_e164 && customerPhone) {
      // Normalize phone to E.164 format
      let normalizedPhone = customerPhone.replace(/[^\d+]/g, '');
      if (normalizedPhone && !normalizedPhone.startsWith('+')) {
        normalizedPhone = '+' + normalizedPhone;
      }
      if (normalizedPhone.length >= 10) {
        updates.phone_e164 = normalizedPhone;
        updates.phone = customerPhone; // Keep original format too
      }
    }

    // Ensure stripe_customer_id is set
    if (!client.stripe_customer_id && stripeCustomerId) {
      updates.stripe_customer_id = stripeCustomerId;
    }

    // Only update if there's something to update
    if (Object.keys(updates).length > 0) {
      updates.last_sync = new Date().toISOString();

      const { error: updateError } = await supabase
        .from('clients')
        .update(updates)
        .eq('id', clientId);

      if (updateError) {
        console.warn(`Failed to enrich client ${clientId}:`, updateError.message);
      } else {
        console.log(`✨ Enriched client ${clientId}:`, Object.keys(updates).join(', '));
      }
    }
  } catch (e) {
    console.warn('enrichClientIfNeeded failed:', e);
  }
}

async function resolveClientFallback(
  supabase: SupabaseClient,
  stripeCustomerId: string | null,
  email: string | null,
  phone: string | null
): Promise<string | null> {
  if (!stripeCustomerId && !email && !phone) return null;

  // Priority 1: stripe_customer_id
  if (stripeCustomerId) {
    const { data } = await supabase
      .from('clients')
      .select('id')
      .eq('stripe_customer_id', stripeCustomerId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  // Priority 2: email
  if (email) {
    const { data } = await supabase
      .from('clients')
      .select('id')
      .eq('email', email.toLowerCase())
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  // Priority 3: phone
  if (phone) {
    const { data } = await supabase
      .from('clients')
      .select('id')
      .eq('phone_e164', phone)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  return null;
}

// ============= MAIN HANDLER =============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

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
    let startDate: string | null = null;
    let endDate: string | null = null;
    let fetchAll = false;
    let cursor: string | null = null;
    let syncRunId: string | null = null;
    let limit = 100;

    try {
      const body: FetchInvoicesRequest = await req.json();
      cursor = body.cursor || null;
      syncRunId = body.syncRunId || null;
      fetchAll = body.fetchAll === true;
      limit = body.limit && body.limit > 0 ? Math.min(body.limit, 100) : 100;

      if (body.startDate) startDate = body.startDate;
      if (body.endDate) endDate = body.endDate;
    } catch {
      // Use defaults
    }

    console.log(`🧾 Starting Stripe Invoices fetch (fetchAll: ${fetchAll}, cursor: ${cursor})`);

    // Check for existing running sync (prevent duplicates)
    if (!syncRunId) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const { data: existingSync } = await supabase
        .from('sync_runs')
        .select('id, started_at, total_fetched, checkpoint')
        .eq('source', 'stripe_invoices')
        .in('status', ['running', 'continuing'])
        .gte('started_at', tenMinutesAgo)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingSync) {
        console.log('⚠️ Sync already running:', existingSync.id);
        return new Response(
          JSON.stringify({
            success: false,
            error: 'sync_already_running',
            existingSyncId: existingSync.id,
            message: 'A sync is already in progress. Please wait.',
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Create new sync run
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .insert({
          source: 'stripe_invoices',
          status: 'running',
          metadata: { fetchAll, startDate, endDate }
        })
        .select('id')
        .single();
      syncRunId = syncRun?.id || null;
    }

    // Build Stripe API URL - fetch ALL statuses
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('expand[]', 'data.subscription');
    params.append('expand[]', 'data.lines.data.price');
    params.append('expand[]', 'data.customer');

    // Date filters
    if (!fetchAll && startDate) {
      params.set('created[gte]', String(Math.floor(new Date(startDate).getTime() / 1000)));
    }
    if (!fetchAll && endDate) {
      params.set('created[lte]', String(Math.floor(new Date(endDate).getTime() / 1000)));
    }

    // Default: last 90 days
    if (!fetchAll && !startDate && !endDate) {
      const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
      params.set('created[gte]', String(ninetyDaysAgo));
    }

    // Cursor for pagination
    if (cursor) {
      params.set('starting_after', cursor);
    }

    const stripeUrl = `https://api.stripe.com/v1/invoices?${params.toString()}`;

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

    console.log(`📄 Fetched ${invoices.length} invoices, hasMore: ${hasMore}`);

    // Stats counters
    const stats = { draft: 0, open: 0, paid: 0, void: 0, uncollectible: 0 };
    let upsertedCount = 0;
    let errorCount = 0;

    // Batch processing
    const invoiceRecords = invoices.map(invoice => {
      // Count by status
      if (invoice.status === 'draft') stats.draft++;
      else if (invoice.status === 'open') stats.open++;
      else if (invoice.status === 'paid') stats.paid++;
      else if (invoice.status === 'void') stats.void++;
      else if (invoice.status === 'uncollectible') stats.uncollectible++;

      // Extract enriched plan info
      const { planName, planInterval, productName } = extractPlanInfo(invoice);

      // Get customer info
      const customer = typeof invoice.customer === 'object' ? invoice.customer : null;
      const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : customer?.id || null;
      const customerEmail = invoice.customer_email || customer?.email || null;
      const customerName = invoice.customer_name || customer?.name || null;
      const customerPhone = customer?.phone || null;
      const customerSnapshot = customer ? {
        id: customer.id,
        email: customer.email || null,
        name: customer.name || null,
        phone: customer.phone || null,
      } : null;
      const customerDetails = invoice.customer_details || null;
      const invoiceMetadata = invoice.metadata || null;

      // NOTE: We do NOT resolve client_id here anymore to save time.
      // The 'harvest_recent_contacts' SQL function (run by sync-command-center)
      // will handle linking invoices to clients in bulk.

      // Get subscription ID
      const subscriptionId = invoice.subscription
        ? (typeof invoice.subscription === 'object' ? invoice.subscription.id : invoice.subscription)
        : null;

      // Get payment intent ID
      const paymentIntentId = invoice.payment_intent
        ? (typeof invoice.payment_intent === 'object' ? invoice.payment_intent.id : invoice.payment_intent)
        : null;

      // Get default payment method ID  
      const defaultPaymentMethod = invoice.default_payment_method
        ? (typeof invoice.default_payment_method === 'object' ? invoice.default_payment_method.id : invoice.default_payment_method)
        : null;

      // Extract line items
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

      // Extract status transitions
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
        // client_id: Link via Harvester SQL
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
        invoice_customer_snapshot: customerSnapshot || customerDetails,
        invoice_metadata: invoiceMetadata,
        raw_data: invoice as unknown as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      };
    });

    if (invoiceRecords.length > 0) {
      const { error, count } = await supabase
        .from("invoices")
        .upsert(invoiceRecords, {
          onConflict: "stripe_invoice_id",
          ignoreDuplicates: false,
          count: 'exact'
        });

      if (error) {
        console.error(`❌ Error bulk upserting invoices:`, error.message);
        throw error;
      } else {
        upsertedCount = invoiceRecords.length; // or count if provided
      }
    }

    // Update sync run
    if (syncRunId) {
      const { data: currentRun } = await supabase
        .from('sync_runs')
        .select('total_fetched, total_inserted')
        .eq('id', syncRunId)
        .single();

      const totalFetched = (currentRun?.total_fetched || 0) + invoices.length;
      const totalInserted = (currentRun?.total_inserted || 0) + upsertedCount;

      await supabase
        .from('sync_runs')
        .update({
          status: hasMore ? 'continuing' : 'completed',
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          checkpoint: hasMore ? { cursor: nextCursor } : null,
          completed_at: hasMore ? null : new Date().toISOString(),
        })
        .eq('id', syncRunId);
    }

    console.log(`✅ Sync page complete: ${upsertedCount} upserted, ${errorCount} errors`);
    console.log(`📊 Stats: ${JSON.stringify(stats)}`);

    const result: FetchInvoicesResponse = {
      success: true,
      synced: invoices.length,
      upserted: upsertedCount,
      hasMore,
      nextCursor,
      syncRunId,
      stats,
      duration_ms: Date.now() - startTime,
    };

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Fatal error:", errorMessage);

    return new Response(
      JSON.stringify({ success: false, error: errorMessage, duration_ms: Date.now() - startTime }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
