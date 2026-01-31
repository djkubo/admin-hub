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

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
}

interface StripeCharge {
  payment_method_details?: {
    card?: { last4?: string; brand?: string };
  };
  failure_code?: string | null;
  failure_message?: string | null;
}

interface StripeInvoice {
  number?: string | null;
  subscription?: string | null;
  lines?: { data?: Array<{ description?: string | null }> };
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
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
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
}

// ============= CONSTANTS =============

const RECORDS_PER_PAGE = 100;
const PAGES_PER_CHUNK = 15; // Process 15 pages per invocation (~1500 tx, ~180s)
const MAX_CHUNKS = 200; // Max ~30,000 tx total
const STRIPE_API_DELAY_MS = 30;

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

const customerEmailCache = new Map<string, { email: string | null; name: string | null; phone: string | null }>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============= HELPERS =============

async function getCustomerInfo(customerId: string, stripeSecretKey: string): Promise<{ email: string | null; name: string | null; phone: string | null }> {
  if (customerEmailCache.has(customerId)) {
    return customerEmailCache.get(customerId)!;
  }

  try {
    const response = await retryWithBackoff(
      () => fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${stripeSecretKey}` }
      }),
      { ...RETRY_CONFIGS.FAST, retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP] }
    );

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

// ============= PROCESS SINGLE PAGE =============

async function processSinglePage(
  supabase: SupabaseClient,
  stripeSecretKey: string,
  startDate: number | null,
  endDate: number | null,
  cursor: string | null
): Promise<{ transactions: TransactionRecord[]; hasMore: boolean; nextCursor: string | null; error: string | null }> {
  try {
    const url = new URL("https://api.stripe.com/v1/payment_intents");
    url.searchParams.set("limit", RECORDS_PER_PAGE.toString());
    url.searchParams.append("expand[]", "data.customer");
    url.searchParams.append("expand[]", "data.latest_charge");
    url.searchParams.append("expand[]", "data.invoice");

    if (startDate) url.searchParams.set("created[gte]", startDate.toString());
    if (endDate) url.searchParams.set("created[lte]", endDate.toString());
    if (cursor) url.searchParams.set("starting_after", cursor);

    const response = await retryWithBackoff(
      () => fetch(url.toString(), { headers: { Authorization: `Bearer ${stripeSecretKey}` } }),
      { ...RETRY_CONFIGS.STANDARD, retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP] }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { transactions: [], hasMore: false, nextCursor: null, error: `Stripe API: ${response.status}` };
    }

    const data: StripeListResponse = await response.json();
    
    if (data.data.length === 0) {
      return { transactions: [], hasMore: false, nextCursor: null, error: null };
    }

    const transactions: TransactionRecord[] = [];

    for (const pi of data.data) {
      let email = pi.receipt_email || null;
      let customerName: string | null = null;
      let customerId: string | null = null;

      if (pi.customer) {
        if (typeof pi.customer === 'object') {
          email = email || pi.customer.email || null;
          customerName = pi.customer.name || null;
          customerId = pi.customer.id;
        } else if (typeof pi.customer === 'string') {
          customerId = pi.customer;
          await delay(STRIPE_API_DELAY_MS);
          const info = await getCustomerInfo(pi.customer, stripeSecretKey);
          email = email || info.email;
          customerName = info.name;
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
        productName = invoice.lines?.data?.[0]?.description || null;
      }
      productName = productName || pi.description || null;

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
      });
    }

    const nextCursor = data.data.length > 0 ? data.data[data.data.length - 1].id : null;
    return { transactions, hasMore: data.has_more, nextCursor, error: null };

  } catch (error) {
    return { transactions: [], hasMore: false, nextCursor: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============= CHUNK PROCESSOR (AUTO-CHAIN) =============

async function processChunk(
  supabase: SupabaseClient,
  stripeSecretKey: string,
  syncRunId: string,
  startDate: number | null,
  endDate: number | null,
  cursor: string | null,
  runningTotal: number,
  chunkNumber: number
) {
  const chunkStart = Date.now();
  let currentCursor = cursor;
  let totalInChunk = 0;
  let hasMore = true;
  let lastError: string | null = null;

  logger.info(`CHUNK ${chunkNumber} START`, { cursor: currentCursor?.slice(-10), runningTotal });

  for (let page = 0; page < PAGES_PER_CHUNK && hasMore; page++) {
    const result = await processSinglePage(supabase, stripeSecretKey, startDate, endDate, currentCursor);

    if (result.error) {
      lastError = result.error;
      logger.error(`Page error`, new Error(result.error));
      await delay(2000);
      continue;
    }

    // BATCH UPSERT - No client enrichment here (deferred)
    if (result.transactions.length > 0) {
      const { error: upsertError } = await supabase
        .from("transactions")
        .upsert(result.transactions, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: false });

      if (upsertError) {
        logger.error(`Upsert error`, new Error(upsertError.message));
      } else {
        totalInChunk += result.transactions.length;
      }
    }

    currentCursor = result.nextCursor;
    hasMore = result.hasMore && currentCursor !== null;

    // Update progress every page with lastActivity timestamp
    await supabase.from('sync_runs').update({
      total_fetched: runningTotal + totalInChunk,
      total_inserted: runningTotal + totalInChunk,
      checkpoint: { 
        cursor: currentCursor, 
        runningTotal: runningTotal + totalInChunk, 
        chunk: chunkNumber, 
        page: page + 1,
        lastActivity: new Date().toISOString()
      }
    }).eq('id', syncRunId);

    if (page % 5 === 0) {
      logger.info(`Chunk ${chunkNumber} progress: ${totalInChunk} tx in ${page + 1} pages`);
    }

    await delay(100);
  }

  const newTotal = runningTotal + totalInChunk;
  const chunkDuration = Math.floor((Date.now() - chunkStart) / 1000);
  logger.info(`CHUNK ${chunkNumber} DONE`, { totalInChunk, newTotal, durationSec: chunkDuration, hasMore });

  // ============= AUTO-CHAIN: Re-invoke if more data =============
  if (hasMore && chunkNumber < MAX_CHUNKS) {
    logger.info(`AUTO-CHAIN: Invoking next chunk ${chunkNumber + 1}`);

    // Update status to "continuing" with lastActivity for stale detection
    await supabase.from('sync_runs').update({
      status: 'continuing',
      checkpoint: { 
        cursor: currentCursor, 
        runningTotal: newTotal, 
        chunk: chunkNumber + 1,
        lastActivity: new Date().toISOString()
      }
    }).eq('id', syncRunId);

    // Self-invoke via EdgeRuntime.waitUntil (fire-and-forget pattern)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const chainPayload = JSON.stringify({
      _continuation: true,
      syncRunId,
      cursor: currentCursor,
      runningTotal: newTotal,
      chunkNumber: chunkNumber + 1,
      startDate: startDate ? new Date(startDate * 1000).toISOString() : null,
      endDate: endDate ? new Date(endDate * 1000).toISOString() : null
    });

    // Use EdgeRuntime.waitUntil for true fire-and-forget
    EdgeRuntime.waitUntil((async () => {
      await delay(500); // Small delay before chain invocation
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await fetch(`${supabaseUrl}/functions/v1/fetch-stripe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceRoleKey}`
            },
            body: chainPayload
          });
          
          if (response.ok) {
            logger.info(`Chain invocation succeeded (attempt ${attempt})`);
            return;
          }
          
          logger.warn(`Chain invocation returned ${response.status}, attempt ${attempt}/3`);
        } catch (chainError) {
          logger.error(`Chain attempt ${attempt} failed`, chainError instanceof Error ? chainError : new Error(String(chainError)));
        }
        
        if (attempt < 3) {
          await delay(2000 * attempt); // Exponential backoff
        }
      }
      
      // All retries failed - mark sync with recoverable state
      logger.error('All chain retries exhausted');
      await supabase.from('sync_runs').update({
        status: 'paused',
        error_message: `Chain failed after 3 retries at chunk ${chunkNumber}. Can resume.`,
        checkpoint: { 
          cursor: currentCursor, 
          runningTotal: newTotal, 
          chunk: chunkNumber, 
          chainFailed: true,
          canResume: true,
          lastActivity: new Date().toISOString()
        }
      }).eq('id', syncRunId);
    })());

    logger.info('Chain invocation scheduled via waitUntil');

  } else {
    // ============= SYNC COMPLETE =============
    await supabase.from('sync_runs').update({
      status: lastError ? 'completed_with_errors' : 'completed',
      completed_at: new Date().toISOString(),
      total_fetched: newTotal,
      total_inserted: newTotal,
      error_message: lastError,
      checkpoint: null,
      metadata: { chunks: chunkNumber, finalTotal: newTotal }
    }).eq('id', syncRunId);

    logger.info('SYNC COMPLETE', { totalTransactions: newTotal, chunks: chunkNumber });
  }
}

// ============= SECURITY =============

function decodeJwtPayload(token: string): { sub?: string; exp?: number; email?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch {
    return null;
  }
}

async function verifyAdminOrServiceRole(req: Request): Promise<{ valid: boolean; isServiceRole: boolean; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, isServiceRole: false, error: 'Missing Authorization header' };
  }

  const token = authHeader.replace('Bearer ', '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  // Allow service role for auto-chain
  if (token === serviceRoleKey) {
    return { valid: true, isServiceRole: true };
  }

  // First, decode JWT locally to check basic validity and expiration
  const claims = decodeJwtPayload(token);
  if (!claims || !claims.sub) {
    return { valid: false, isServiceRole: false, error: 'Invalid token format' };
  }

  // Check expiration locally (faster than API call)
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now >= claims.exp) {
    return { valid: false, isServiceRole: false, error: 'Token expired' };
  }

  // Create Supabase client with the user's token
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  // Verify admin status - this also validates the token is accepted by Supabase
  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_admin');
  
  if (rpcError) {
    logger.warn('is_admin RPC failed', { error: rpcError.message });
    return { valid: false, isServiceRole: false, error: `Auth check failed: ${rpcError.message}` };
  }
  
  if (!isAdmin) {
    return { valid: false, isServiceRole: false, error: 'Not an admin' };
  }

  return { valid: true, isServiceRole: false };
}

// ============= MAIN HANDLER =============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authCheck = await verifyAdminOrServiceRole(req);
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

    // Parse body first to check for _continuation flag
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body */ }

    // ============= KILL SWITCH: Check if sync is paused =============
    const { data: syncPausedConfig } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'sync_paused')
      .single();

    const syncPaused = syncPausedConfig?.value === 'true';
    
    if (syncPaused) {
      logger.info('⏸️ Sync paused globally, skipping execution');
      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'skipped', 
          skipped: true, 
          reason: 'Feature disabled: sync_paused is ON' 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ================================================================

    // ========== CONTINUATION (AUTO-CHAIN) ==========
    if (body._continuation && authCheck.isServiceRole) {
      logger.info('CONTINUATION received', { syncRunId: body.syncRunId, chunk: body.chunkNumber });

      const startDate = body.startDate ? Math.floor(new Date(body.startDate).getTime() / 1000) : null;
      const endDate = body.endDate ? Math.floor(new Date(body.endDate).getTime() / 1000) : null;

      // Run chunk in background
      EdgeRuntime.waitUntil(
        processChunk(supabase, stripeSecretKey, body.syncRunId, startDate, endDate, body.cursor, body.runningTotal, body.chunkNumber)
      );

      return new Response(
        JSON.stringify({ success: true, status: 'continuing', chunk: body.chunkNumber }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== RESUME PAUSED/FAILED SYNC ==========
    if (body.resumeSync || body.resumeFromCursor) {
      // If resumeFromCursor is passed, we look for a sync with that cursor
      // If resumeSync is true, we find the most recent resumable sync
      
      let pausedSync: { id: string; checkpoint: any } | null = null;
      
      if (body.resumeFromCursor) {
        // Find sync by cursor
        const { data } = await supabase
          .from('sync_runs')
          .select('id, checkpoint')
          .eq('source', 'stripe')
          .in('status', ['paused', 'failed'])
          .order('started_at', { ascending: false })
          .limit(10);
        
        // Find the one with matching cursor
        pausedSync = data?.find((s: any) => s.checkpoint?.cursor === body.resumeFromCursor) || null;
        
        // If not found by cursor, just get the most recent with any checkpoint
        if (!pausedSync && data && data.length > 0) {
          pausedSync = data.find((s: any) => s.checkpoint?.cursor) || null;
        }
      } else {
        // Get most recent resumable
        const { data } = await supabase
          .from('sync_runs')
          .select('id, checkpoint')
          .eq('source', 'stripe')
          .in('status', ['paused', 'failed'])
          .order('started_at', { ascending: false })
          .limit(1)
          .single();
        pausedSync = data;
      }

      if (!pausedSync || !pausedSync.checkpoint) {
        return new Response(
          JSON.stringify({ success: false, error: 'No resumable sync found' }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const checkpoint = pausedSync.checkpoint as any;
      
      // Mark as running again
      await supabase.from('sync_runs').update({
        status: 'running',
        error_message: null,
        checkpoint: { ...checkpoint, lastActivity: new Date().toISOString(), resumed: true }
      }).eq('id', pausedSync.id);

      const startDate = body.startDate ? Math.floor(new Date(body.startDate).getTime() / 1000) : null;
      const endDate = body.endDate ? Math.floor(new Date(body.endDate).getTime() / 1000) : null;

      EdgeRuntime.waitUntil(
        processChunk(supabase, stripeSecretKey, pausedSync.id, startDate, endDate, checkpoint.cursor, checkpoint.runningTotal || 0, (checkpoint.chunk || 1) + 1)
      );

      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'resumed', 
          run_id: pausedSync.id,
          syncRunId: pausedSync.id,
          resumedFrom: checkpoint.runningTotal || 0,
          cursor: checkpoint.cursor?.slice(-15)
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== FORCE CANCEL ==========
    if (body.forceCancel) {
      const { data: cancelled } = await supabase
        .from('sync_runs')
        .update({ status: 'cancelled', completed_at: new Date().toISOString(), error_message: 'Cancelado por usuario' })
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing', 'paused'])
        .select('id');

      return new Response(
        JSON.stringify({ success: true, cancelled: cancelled?.length || 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== CLEANUP STALE ==========
    if (body.cleanupStale) {
      const threshold = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min threshold
      const { data: cleaned } = await supabase
        .from('sync_runs')
        .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout cleanup (no activity >10min)' })
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing'])
        .lt('started_at', threshold)
        .select('id');

      return new Response(
        JSON.stringify({ success: true, cleaned: cleaned?.length || 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== CHECK EXISTING SYNC ==========
    // Check for truly stale syncs (no activity in 10 minutes) - based on checkpoint.lastActivity
    const { data: staleRuns } = await supabase
      .from('sync_runs')
      .select('id, checkpoint')
      .eq('source', 'stripe')
      .in('status', ['running', 'continuing']);
    
    if (staleRuns && staleRuns.length > 0) {
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      
      for (const run of staleRuns) {
        const checkpoint = run.checkpoint as any;
        const lastActivity = checkpoint?.lastActivity ? new Date(checkpoint.lastActivity).getTime() : 0;
        
        // Only mark as failed if lastActivity is truly stale (>10 min)
        if (lastActivity > 0 && lastActivity < tenMinutesAgo) {
          await supabase.from('sync_runs').update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: `Auto-cleanup: no activity for >10min (last: ${checkpoint?.lastActivity})`
          }).eq('id', run.id);
        }
      }
    }

    const { data: existing } = await supabase
      .from('sync_runs')
      .select('id, total_fetched, checkpoint')
      .eq('source', 'stripe')
      .in('status', ['running', 'continuing'])
      .limit(1);

    if (existing && existing.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'sync_already_running',
          existingSyncId: existing[0].id,
          currentTotal: existing[0].total_fetched || 0,
          message: 'Ya hay un sync en progreso'
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== CREATE NEW SYNC ==========
    const fetchAll = body.fetchAll === true;
    const startDate = body.startDate ? Math.floor(new Date(body.startDate).getTime() / 1000) : null;
    const endDate = body.endDate ? Math.floor(new Date(body.endDate).getTime() / 1000) : null;

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

    logger.info(`NEW SYNC: ${syncRun.id}`, { fetchAll });

    if (fetchAll) {
      // Start first chunk in background
      EdgeRuntime.waitUntil(
        processChunk(supabase, stripeSecretKey, syncRun.id, startDate, endDate, null, 0, 1)
      );

      return new Response(
        JSON.stringify({
          success: true,
          status: 'running',
          syncRunId: syncRun.id,
          message: 'Sync iniciado con auto-continuación. Procesa ~1500 tx cada 2-3 min.',
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Single page sync
    const result = await processSinglePage(supabase, stripeSecretKey, startDate, endDate, null);

    if (result.transactions.length > 0) {
      await supabase.from("transactions").upsert(result.transactions, { onConflict: "stripe_payment_intent_id" });
    }

    await supabase.from('sync_runs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      total_fetched: result.transactions.length,
      total_inserted: result.transactions.length
    }).eq('id', syncRun.id);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        synced_transactions: result.transactions.length,
        hasMore: result.hasMore
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    logger.error("Fatal error", error instanceof Error ? error : new Error(String(error)));
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
