import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============= TYPE DEFINITIONS =============

interface AdminVerifyResult {
  valid: boolean;
  error?: string;
  userId?: string;
}

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
}

interface StripeCharge {
  id: string;
  payment_method_details?: {
    card?: { brand?: string; last4?: string };
  };
  outcome?: { reason?: string };
  failure_code?: string;
  failure_message?: string;
}

interface StripeInvoice {
  id: string;
  number: string | null;
  subscription?: string | null;
  lines?: {
    data: Array<{
      description?: string;
      price?: { product?: string | { id: string; name: string } };
    }>;
  };
}

interface StripePaymentIntent {
  id: string;
  customer: string | StripeCustomer | null;
  amount: number;
  currency: string;
  status: string;
  last_payment_error?: { code?: string; message?: string; decline_code?: string } | null;
  created: number;
  metadata: Record<string, string>;
  receipt_email?: string | null;
  latest_charge?: string | StripeCharge | null;
  invoice?: string | StripeInvoice | null;
  description?: string | null;
}

interface StripeListResponse {
  data: StripePaymentIntent[];
  has_more: boolean;
}

interface PageResult {
  transactions: number;
  clients: number;
  skipped: number;
  paidCount: number;
  failedCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
}

interface TransactionRecord {
  stripe_payment_intent_id: string;
  external_transaction_id: string;
  payment_key: string;
  amount: number;
  currency: string;
  status: string;
  customer_email: string;
  stripe_customer_id: string | null;
  stripe_created_at: string;
  source: string;
  subscription_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  payment_type: string;
  metadata: Record<string, unknown>;
  raw_data: Record<string, unknown>;
}

interface ClientRecord {
  email: string;
  full_name: string | null;
  phone: string | null;
  stripe_customer_id: string | null;
  lifecycle_stage: string;
  last_sync: string;
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

// ============= CONSTANTS =============

const DECLINE_REASONS_ES: Record<string, string> = {
  'insufficient_funds': 'Fondos insuficientes',
  'lost_card': 'Tarjeta perdida',
  'stolen_card': 'Tarjeta robada',
  'expired_card': 'Tarjeta expirada',
  'incorrect_cvc': 'CVC incorrecto',
  'processing_error': 'Error de procesamiento',
  'incorrect_number': 'Número incorrecto',
  'card_velocity_exceeded': 'Límite de transacciones excedido',
  'do_not_honor': 'Transacción rechazada por el banco',
  'generic_decline': 'Rechazo genérico',
  'card_declined': 'Tarjeta rechazada',
  'fraudulent': 'Transacción sospechosa',
  'blocked': 'Tarjeta bloqueada',
};

const RECORDS_PER_PAGE = 100;
const STRIPE_API_DELAY_MS = 50;
const STALE_TIMEOUT_MINUTES = 30;

// ============= HELPERS =============

const customerEmailCache = new Map<string, { email: string | null; name: string | null; phone: string | null }>();

async function getCustomerInfo(customerId: string, stripeSecretKey: string): Promise<{ email: string | null; name: string | null; phone: string | null }> {
  if (customerEmailCache.has(customerId)) {
    return customerEmailCache.get(customerId)!;
  }

  try {
    const response = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` }
    });

    if (!response.ok) {
      customerEmailCache.set(customerId, { email: null, name: null, phone: null });
      return { email: null, name: null, phone: null };
    }

    const customer: StripeCustomer = await response.json();
    const info = { email: customer.email || null, name: customer.name || null, phone: customer.phone || null };
    customerEmailCache.set(customerId, info);
    return info;
  } catch {
    customerEmailCache.set(customerId, { email: null, name: null, phone: null });
    return { email: null, name: null, phone: null };
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============= PROCESS SINGLE PAGE =============

async function processSinglePage(
  supabase: SupabaseClient,
  stripeSecretKey: string,
  startDate: number | null,
  endDate: number | null,
  cursor: string | null
): Promise<PageResult> {
  let paidCount = 0;
  let failedCount = 0;
  let skippedNoEmail = 0;

  try {
    const url = new URL("https://api.stripe.com/v1/payment_intents");
    url.searchParams.set("limit", RECORDS_PER_PAGE.toString());
    url.searchParams.append("expand[]", "data.customer");
    url.searchParams.append("expand[]", "data.latest_charge");
    url.searchParams.append("expand[]", "data.invoice");
    
    if (startDate) url.searchParams.set("created[gte]", startDate.toString());
    if (endDate) url.searchParams.set("created[lte]", endDate.toString());
    if (cursor) url.searchParams.set("starting_after", cursor);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Stripe API error:", response.status, errorText);
      return {
        transactions: 0,
        clients: 0,
        skipped: 0,
        paidCount: 0,
        failedCount: 0,
        hasMore: false,
        nextCursor: null,
        error: `Stripe API error: ${response.status} - ${errorText.substring(0, 200)}`
      };
    }

    const data: StripeListResponse = await response.json();
    
    if (data.data.length === 0) {
      return {
        transactions: 0,
        clients: 0,
        skipped: 0,
        paidCount: 0,
        failedCount: 0,
        hasMore: false,
        nextCursor: null,
        error: null
      };
    }

    const transactions: TransactionRecord[] = [];
    const clientsMap = new Map<string, ClientRecord>();

    for (const pi of data.data) {
      let email = pi.receipt_email || null;
      let customerName: string | null = null;
      let customerPhone: string | null = null;
      let customerId: string | null = null;

      if (pi.customer) {
        if (typeof pi.customer === 'object' && pi.customer !== null) {
          email = email || pi.customer.email || null;
          customerName = pi.customer.name || null;
          customerPhone = pi.customer.phone || null;
          customerId = pi.customer.id;
        } else if (typeof pi.customer === 'string') {
          customerId = pi.customer;
          await delay(STRIPE_API_DELAY_MS);
          const info = await getCustomerInfo(pi.customer, stripeSecretKey);
          email = email || info.email;
          customerName = info.name;
          customerPhone = info.phone;
        }
      }

      if (!email) {
        skippedNoEmail++;
        continue;
      }

      let cardLast4: string | null = null;
      let cardBrand: string | null = null;
      let chargeFailureCode: string | null = null;
      let chargeFailureMessage: string | null = null;
      let chargeOutcomeReason: string | null = null;

      if (pi.latest_charge && typeof pi.latest_charge === 'object') {
        const charge = pi.latest_charge as StripeCharge;
        cardLast4 = charge.payment_method_details?.card?.last4 || null;
        cardBrand = charge.payment_method_details?.card?.brand || null;
        chargeFailureCode = charge.failure_code || null;
        chargeFailureMessage = charge.failure_message || null;
        chargeOutcomeReason = charge.outcome?.reason || null;
      }

      let productName: string | null = null;
      let invoiceNumber: string | null = null;
      let subscriptionId: string | null = null;

      if (pi.invoice && typeof pi.invoice === 'object') {
        const invoice = pi.invoice as StripeInvoice;
        invoiceNumber = invoice.number || null;
        subscriptionId = invoice.subscription || null;
        if (invoice.lines?.data?.[0]) {
          const firstLine = invoice.lines.data[0];
          productName = firstLine.description || null;
          if (!productName && firstLine.price?.product) {
            if (typeof firstLine.price.product === 'object') {
              productName = firstLine.price.product.name || null;
            }
          }
        }
      }

      if (!productName && pi.description) {
        productName = pi.description;
      }

      let mappedStatus: string;
      const failureCode = pi.last_payment_error?.code || pi.last_payment_error?.decline_code || chargeFailureCode || null;
      const failureMessage = pi.last_payment_error?.message || chargeFailureMessage || null;
      let declineReasonEs: string | null = null;

      switch (pi.status) {
        case "succeeded":
          mappedStatus = "paid";
          paidCount++;
          break;
        case "requires_payment_method":
          mappedStatus = "failed";
          failedCount++;
          declineReasonEs = (failureCode && DECLINE_REASONS_ES[failureCode]) || "Pago rechazado";
          break;
        case "requires_action":
        case "requires_confirmation":
        case "processing":
          mappedStatus = "pending";
          break;
        case "canceled":
          mappedStatus = "canceled";
          break;
        default:
          mappedStatus = "failed";
          failedCount++;
      }

      const metadata: Record<string, unknown> = {
        ...(pi.metadata || {}),
        card_last4: cardLast4,
        card_brand: cardBrand,
        product_name: productName,
        invoice_number: invoiceNumber,
        decline_reason_es: declineReasonEs,
        customer_name: customerName,
        charge_outcome_reason: chargeOutcomeReason,
      };

      transactions.push({
        stripe_payment_intent_id: pi.id,
        external_transaction_id: pi.id,
        payment_key: pi.id,
        amount: pi.amount,
        currency: pi.currency?.toLowerCase() || "usd",
        status: mappedStatus,
        customer_email: email.toLowerCase(),
        stripe_customer_id: customerId,
        stripe_created_at: new Date(pi.created * 1000).toISOString(),
        source: "stripe",
        subscription_id: subscriptionId,
        failure_code: failureCode,
        failure_message: failureMessage,
        payment_type: "card",
        metadata,
        raw_data: pi as unknown as Record<string, unknown>,
      });

      if (email) {
        const emailLower = email.toLowerCase();
        if (!clientsMap.has(emailLower)) {
          clientsMap.set(emailLower, {
            email: emailLower,
            full_name: customerName || null,
            phone: customerPhone || null,
            stripe_customer_id: customerId,
            lifecycle_stage: mappedStatus === "paid" ? "CUSTOMER" : "LEAD",
            last_sync: new Date().toISOString(),
          });
        }
      }
    }

    // Save transactions
    let transactionsSaved = 0;
    if (transactions.length > 0) {
      const { error: txError, data: txData } = await supabase
        .from("transactions")
        .upsert(transactions, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: false })
        .select("id");

      if (txError) {
        console.error(`Transaction upsert error:`, txError.message);
      } else {
        transactionsSaved = txData?.length || 0;
      }
    }

    // Save clients
    let clientsSaved = 0;
    const clientsToSave = Array.from(clientsMap.values());
    if (clientsToSave.length > 0) {
      const { error: clientError, data: clientData } = await supabase
        .from("clients")
        .upsert(clientsToSave, { onConflict: "email", ignoreDuplicates: false })
        .select("id");

      if (!clientError) {
        clientsSaved = clientData?.length || 0;
      }
    }

    const nextCursor = data.data.length > 0 ? data.data[data.data.length - 1].id : null;

    return {
      transactions: transactionsSaved,
      clients: clientsSaved,
      skipped: skippedNoEmail,
      paidCount,
      failedCount,
      hasMore: data.has_more,
      nextCursor,
      error: null
    };

  } catch (error) {
    return {
      transactions: 0,
      clients: 0,
      skipped: 0,
      paidCount: 0,
      failedCount: 0,
      hasMore: false,
      nextCursor: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
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

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ success: false, error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    let fetchAll = false;
    let startDate: number | null = null;
    let endDate: number | null = null;
    let cursor: string | null = null;
    let syncRunId: string | null = null;
    let cleanupStale = false;
    
    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      cleanupStale = body.cleanupStale === true;
      
      if (body.startDate) {
        startDate = Math.floor(new Date(body.startDate).getTime() / 1000);
      }
      if (body.endDate) {
        endDate = Math.floor(new Date(body.endDate).getTime() / 1000);
      }
      
      cursor = body.cursor || null;
      syncRunId = body.syncRunId || null;
    } catch {
      // No body or parse error - use defaults
    }

    // ============ CLEANUP STALE SYNCS ============
    if (cleanupStale) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      const { data: staleSyncs } = await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Marcado como fallido por timeout (sin actividad por 30 minutos)'
        })
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold)
        .select('id');
      
      console.log(`🧹 Cleaned up ${staleSyncs?.length || 0} stale Stripe syncs`);
      
      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'completed',
          cleaned: staleSyncs?.length || 0,
          message: `${staleSyncs?.length || 0} syncs marcados como fallidos`,
          duration_ms: Date.now() - startTime
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ CHECK FOR EXISTING SYNC ============
    if (!syncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Timeout - sin actividad por 30 minutos'
        })
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold);

      const { data: existingRuns } = await supabase
        .from('sync_runs')
        .select('id')
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing'])
        .limit(1);

      if (existingRuns && existingRuns.length > 0) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            status: 'failed',
            error: 'sync_already_running',
            message: 'Ya hay un sync de Stripe en progreso',
            existingSyncId: existingRuns[0].id
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ============ CREATE/RESUME SYNC RUN ============
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'stripe',
          status: 'running',
          metadata: { fetchAll, startDate, endDate }
        })
        .select('id')
        .single();
      
      if (syncError) {
        return new Response(
          JSON.stringify({ success: false, status: 'failed', error: "Failed to create sync record" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      syncRunId = syncRun?.id;
      console.log(`📊 NEW STRIPE SYNC RUN: ${syncRunId}`);
    } else {
      await supabase
        .from('sync_runs')
        .update({ 
          status: 'running',
          checkpoint: { cursor, lastActivity: new Date().toISOString() }
        })
        .eq('id', syncRunId);
      console.log(`📊 RESUMING STRIPE SYNC: ${syncRunId}`);
    }

    // ============ PROCESS PAGE ============
    const result = await processSinglePage(supabase, stripeSecretKey, startDate, endDate, cursor);

    if (result.error) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: result.error
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ success: false, status: 'failed', syncRunId, error: result.error }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ CHECK FOR MORE PAGES ============
    const hasMore = fetchAll && result.hasMore && result.nextCursor;

    if (hasMore) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: result.transactions,
          total_inserted: result.transactions,
          checkpoint: { 
            cursor: result.nextCursor,
            lastActivity: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          syncRunId,
          synced_transactions: result.transactions,
          synced_clients: result.clients,
          skipped: result.skipped,
          paid_count: result.paidCount,
          failed_count: result.failedCount,
          hasMore: true,
          nextCursor: result.nextCursor,
          duration_ms: Date.now() - startTime
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ COMPLETE ============
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: result.transactions,
        total_inserted: result.transactions,
        checkpoint: null
      })
      .eq('id', syncRunId);

    console.log(`🎉 STRIPE SYNC COMPLETE: ${result.transactions} transactions in ${Date.now() - startTime}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId,
        synced_transactions: result.transactions,
        synced_clients: result.clients,
        skipped: result.skipped,
        paid_count: result.paidCount,
        failed_count: result.failedCount,
        hasMore: false,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, status: 'failed', error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
