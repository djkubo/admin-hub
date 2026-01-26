import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';

// Declare EdgeRuntime for background tasks
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const logger = createLogger('fetch-stripe', LogLevel.INFO);

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

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
}

interface StripeCharge {
  payment_method_details?: {
    card?: {
      last4?: string;
      brand?: string;
    };
  };
  failure_code?: string | null;
  failure_message?: string | null;
}

interface StripeInvoice {
  number?: string | null;
  subscription?: string | null;
  lines?: {
    data?: Array<{
      description?: string | null;
    }>;
  };
}

interface StripePaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  customer: string | StripeCustomer | null;
  receipt_email?: string | null;
  description?: string | null;
  latest_charge?: string | StripeCharge | null;
  invoice?: string | StripeInvoice | null;
  last_payment_error?: {
    code?: string;
    decline_code?: string;
    message?: string;
  } | null;
}

interface StripeListResponse {
  data: StripePaymentIntent[];
  has_more: boolean;
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
  // ... (keep logic but use logger if needed, though simple logic is fine) ...
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
const MAX_PAGES = 2000;
const STRIPE_API_DELAY_MS = 50; // Small delay to avoid rate limits when fetching customer details

const customerEmailCache = new Map<string, { email: string | null; name: string | null; phone: string | null }>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getCustomerInfo(customerId: string, stripeSecretKey: string): Promise<{ email: string | null; name: string | null; phone: string | null }> {
  if (customerEmailCache.has(customerId)) {
    return customerEmailCache.get(customerId)!;
  }

  try {
    // Retry wrapper
    const response = await retryWithBackoff(
      () => fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${stripeSecretKey}` }
      }),
      {
        ...RETRY_CONFIGS.FAST,
        retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP]
      }
    );

    if (!response.ok) {
      // Cache nulls to avoid repeated failures
      customerEmailCache.set(customerId, { email: null, name: null, phone: null });
      return { email: null, name: null, phone: null };
    }

    const customer: StripeCustomer = await response.json();
    const info = { email: customer.email || null, name: customer.name || null, phone: customer.phone || null };
    customerEmailCache.set(customerId, info);
    return info;
  } catch (error) {
    logger.warn(`Error fetching customer ${customerId}`, { error: String(error) });
    customerEmailCache.set(customerId, { email: null, name: null, phone: null });
    return { email: null, name: null, phone: null };
  }
}

// ============= PROCESS SINGLE PAGE =============

async function processSinglePage(
  supabase: SupabaseClient,
  stripeSecretKey: string,
  startDate: number | null,
  endDate: number | null,
  cursor: string | null
): Promise<{ transactions: number; clients: number; hasMore: boolean; nextCursor: string | null; error: string | null }> {
  try {
    const url = new URL("https://api.stripe.com/v1/payment_intents");
    url.searchParams.set("limit", RECORDS_PER_PAGE.toString());
    url.searchParams.append("expand[]", "data.customer");
    url.searchParams.append("expand[]", "data.latest_charge");
    url.searchParams.append("expand[]", "data.invoice");

    if (startDate) url.searchParams.set("created[gte]", startDate.toString());
    if (endDate) url.searchParams.set("created[lte]", endDate.toString());
    if (cursor) url.searchParams.set("starting_after", cursor);

    logger.info('Fetching Stripe transactions', { startDate, endDate, cursor, limit: RECORDS_PER_PAGE });

    const response = await retryWithBackoff(
      () => fetch(url.toString(), {
        headers: { Authorization: `Bearer ${stripeSecretKey}` },
      }),
      {
        ...RETRY_CONFIGS.STANDARD,
        retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP]
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Stripe API error: ${response.status}`, new Error(errorText), { cursor });
      return { transactions: 0, clients: 0, hasMore: false, nextCursor: null, error: `Stripe API: ${response.status} - ${errorText.substring(0, 100)}` };
    }

    const data: StripeListResponse = await response.json();
    logger.info('Fetched Stripe transactions', { count: data.data.length, hasMore: data.has_more });

    if (data.data.length === 0) {
      return { transactions: 0, clients: 0, hasMore: false, nextCursor: null, error: null };
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

      if (!email) continue;

      let cardLast4: string | null = null;
      let cardBrand: string | null = null;
      let chargeFailureCode: string | null = null;
      let chargeFailureMessage: string | null = null;

      if (pi.latest_charge && typeof pi.latest_charge === 'object') {
        const charge = pi.latest_charge as StripeCharge;
        cardLast4 = charge.payment_method_details?.card?.last4 || null;
        cardBrand = charge.payment_method_details?.card?.brand || null;
        chargeFailureCode = charge.failure_code || null;
        chargeFailureMessage = charge.failure_message || null;
      }

      let productName: string | null = null;
      let invoiceNumber: string | null = null;
      let subscriptionId: string | null = null;

      if (pi.invoice && typeof pi.invoice === 'object') {
        const invoice = pi.invoice as StripeInvoice;
        invoiceNumber = invoice.number || null;
        subscriptionId = invoice.subscription || null;
        if (invoice.lines?.data?.[0]) {
          productName = invoice.lines.data[0].description || null;
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
        case "succeeded": mappedStatus = "paid"; break;
        case "requires_payment_method":
          mappedStatus = "failed";
          declineReasonEs = (failureCode && DECLINE_REASONS_ES[failureCode]) || "Pago rechazado";
          break;
        case "requires_action":
        case "requires_confirmation":
        case "processing":
          mappedStatus = "pending"; break;
        case "canceled": mappedStatus = "canceled"; break;
        default: mappedStatus = "failed";
      }

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
        metadata: { card_last4: cardLast4, card_brand: cardBrand, product_name: productName, invoice_number: invoiceNumber, decline_reason_es: declineReasonEs, customer_name: customerName },
        raw_data: pi as unknown as Record<string, unknown>,
      });

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

    // Save transactions
    let transactionsSaved = 0;
    if (transactions.length > 0) {
      const { data: txData } = await supabase
        .from("transactions")
        .upsert(transactions, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: false })
        .select("id");
      transactionsSaved = txData?.length || 0;
    }

    // Save clients
    let clientsSaved = 0;
    const clientsToSave = Array.from(clientsMap.values());
    if (clientsToSave.length > 0) {
      const { data: clientData } = await supabase
        .from("clients")
        .upsert(clientsToSave, { onConflict: "email", ignoreDuplicates: false })
        .select("id");
      clientsSaved = clientData?.length || 0;
    }

    const nextCursor = data.data.length > 0 ? data.data[data.data.length - 1].id : null;

    return {
      transactions: transactionsSaved,
      clients: clientsSaved,
      hasMore: data.has_more,
      nextCursor,
      error: null
    };

  } catch (error) {
    return { transactions: 0, clients: 0, hasMore: false, nextCursor: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============= FULL SYNC (BACKGROUND TASK) =============

async function runFullSync(
  supabase: SupabaseClient,
  stripeSecretKey: string,
  syncRunId: string,
  startDate: number | null,
  endDate: number | null,
  initialCursor: string | null,
  initialTotal: number
) {
  let cursor = initialCursor;
  let totalTransactions = initialTotal;
  let pageCount = 0;
  let hasMore = true;
  let lastError: string | null = null;

  logger.info('Starting full sync', { syncRunId, startDate, cursor, total: totalTransactions });

  try {
    while (hasMore && pageCount < MAX_PAGES) {
      pageCount++;

      const result = await processSinglePage(supabase, stripeSecretKey, startDate, endDate, cursor);

      if (result.error) {
        lastError = result.error;
        logger.error(`Page ${pageCount} error`, new Error(result.error));
        // Wait and retry once
        await delay(5000);
        const retry = await processSinglePage(supabase, stripeSecretKey, startDate, endDate, cursor);
        if (retry.error) {
          logger.error(`Retry failed`, new Error(retry.error));
          break;
        }
        totalTransactions += retry.transactions;
        cursor = retry.nextCursor;
        hasMore = retry.hasMore && cursor !== null;
      } else {
        totalTransactions += result.transactions;
        cursor = result.nextCursor;
        hasMore = result.hasMore && cursor !== null;
      }

      // Update progress every page
      await supabase
        .from('sync_runs')
        .update({
          status: hasMore ? 'running' : 'completed',
          total_fetched: totalTransactions,
          total_inserted: totalTransactions,
          checkpoint: hasMore ? { cursor, runningTotal: totalTransactions, page: pageCount, lastActivity: new Date().toISOString() } : null,
          completed_at: hasMore ? null : new Date().toISOString()
        })
        .eq('id', syncRunId);

      if (pageCount % 10 === 0) {
        logger.info(`Progress: ${totalTransactions} tx in ${pageCount} pages`);
      }

      // Small delay between pages
      if (hasMore) {
        await delay(200);
      }
    }

    // Final update
    await supabase
      .from('sync_runs')
      .update({
        status: lastError ? 'completed_with_errors' : 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalTransactions,
        total_inserted: totalTransactions,
        error_message: lastError,
        checkpoint: null
      })
      .eq('id', syncRunId);

    logger.info(`SYNC COMPLETE`, { totalTransactions, pageCount });

  } catch (error) {
    logger.error(`Fatal sync error`, error instanceof Error ? error : new Error(String(error)));
    await supabase
      .from('sync_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        total_fetched: totalTransactions,
        error_message: error instanceof Error ? error.message : 'Unknown error'
      })
      .eq('id', syncRunId);
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
    let resumeSyncId: string | null = null;
    let cleanupStale = false;
    let forceCancel = false;

    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      cleanupStale = body.cleanupStale === true;
      forceCancel = body.forceCancel === true;
      resumeSyncId = body.resumeSyncId || null;

      if (body.startDate) startDate = Math.floor(new Date(body.startDate).getTime() / 1000);
      if (body.endDate) endDate = Math.floor(new Date(body.endDate).getTime() / 1000);
    } catch {
      // No body - use defaults
    }

    // ============ FORCE CANCEL ALL SYNCS ============
    if (forceCancel) {
      const { data: cancelledSyncs, error: cancelError } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(), 
          error_message: 'Cancelado forzosamente por usuario' 
        })
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing'])
        .select('id');

      logger.info('Force cancelled syncs', { count: cancelledSyncs?.length || 0, error: cancelError });

      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'cancelled', 
          cancelled: cancelledSyncs?.length || 0,
          message: `Se cancelaron ${cancelledSyncs?.length || 0} sincronizaciones` 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ CLEANUP STALE SYNCS ============
    if (cleanupStale) {
      const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // Reduced from 30 to 15 min
      const { data: staleSyncs } = await supabase
        .from('sync_runs')
        .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout' })
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold)
        .select('id');

      return new Response(
        JSON.stringify({ success: true, status: 'completed', cleaned: staleSyncs?.length || 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ RESUME EXISTING SYNC ============
    if (resumeSyncId) {
      const { data: existingRun } = await supabase
        .from('sync_runs')
        .select('id, status, total_fetched, checkpoint')
        .eq('id', resumeSyncId)
        .single();

      if (!existingRun) {
        return new Response(
          JSON.stringify({ success: false, error: 'Sync not found' }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cursor = existingRun.checkpoint?.cursor || null;
      const previousTotal = existingRun.total_fetched || 0;

      console.log(`📊 RESUMING SYNC: ${resumeSyncId}, cursor: ${cursor}, total: ${previousTotal}`);

      // Run in background
      EdgeRuntime.waitUntil(runFullSync(supabase, stripeSecretKey, resumeSyncId, startDate, endDate, cursor, previousTotal));

      return new Response(
        JSON.stringify({
          success: true,
          status: 'running',
          syncRunId: resumeSyncId,
          message: 'Sync resumed in background',
          resumedFrom: previousTotal
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ CHECK FOR EXISTING SYNC ============
    // Auto-cleanup stale syncs (15 min threshold - aggressive cleanup to prevent blocking)
    const staleAutoCleanup = await supabase
      .from('sync_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout - auto-cleanup 15min' })
      .eq('source', 'stripe')
      .in('status', ['running', 'continuing'])
      .lt('started_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
      .select('id');
    
    if (staleAutoCleanup.data && staleAutoCleanup.data.length > 0) {
      logger.info('Auto-cleaned stale syncs', { count: staleAutoCleanup.data.length });
    }

    const { data: existingRuns } = await supabase
      .from('sync_runs')
      .select('id, total_fetched, checkpoint')
      .eq('source', 'stripe')
      .in('status', ['running', 'continuing'])
      .limit(1);

    if (existingRuns && existingRuns.length > 0) {
      // Return existing sync info so user can resume
      return new Response(
        JSON.stringify({
          success: false,
          error: 'sync_already_running',
          existingSyncId: existingRuns[0].id,
          currentTotal: existingRuns[0].total_fetched || 0,
          message: 'Hay un sync en progreso. Usa resumeSyncId para continuar.'
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ CREATE NEW SYNC ============
    const { data: syncRun, error: syncError } = await supabase
      .from('sync_runs')
      .insert({ source: 'stripe', status: 'running', metadata: { fetchAll, startDate, endDate } })
      .select('id')
      .single();

    if (syncError || !syncRun) {
      return new Response(
        JSON.stringify({ success: false, error: "Failed to create sync record" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`📊 NEW SYNC: ${syncRun.id}`);

    // Run in background for full syncs
    if (fetchAll) {
      EdgeRuntime.waitUntil(runFullSync(supabase, stripeSecretKey, syncRun.id, startDate, endDate, null, 0));

      return new Response(
        JSON.stringify({
          success: true,
          status: 'running',
          syncRunId: syncRun.id,
          message: 'Full sync started in background. Check sync_runs table for progress.',
          duration_ms: Date.now() - startTime
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Single page sync for non-full requests
    const result = await processSinglePage(supabase, stripeSecretKey, startDate, endDate, null);

    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: result.transactions,
        total_inserted: result.transactions
      })
      .eq('id', syncRun.id);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId: syncRun.id,
        synced_transactions: result.transactions,
        synced_clients: result.clients,
        hasMore: result.hasMore,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
