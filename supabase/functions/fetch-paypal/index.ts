import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const logger = createLogger('fetch-paypal', LogLevel.INFO);
const STALE_TIMEOUT_MINUTES = 3;
const MAX_DAYS_PER_CHUNK = 31; // PayPal API maximum range

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

interface PayPalPageResult {
  transactions: PayPalTransaction[];
  totalPages: number;
  totalItems: number;
}

interface PayPalTransaction {
  transaction_info: {
    transaction_id: string;
    transaction_status: string;
    transaction_event_code: string;
    transaction_amount: { value: string; currency_code: string; };
    fee_amount?: { value: string; };
    transaction_subject?: string;
    transaction_note?: string;
    transaction_initiation_date: string;
  };
  payer_info: {
    email_address?: string;
    account_id?: string;
    payer_name?: { given_name?: string; surname?: string; };
  };
  cart_info?: { item_details?: Array<{ item_name?: string; }>; };
}

interface TransactionRecord {
  stripe_payment_intent_id: string;
  payment_key: string;
  external_transaction_id: string;
  customer_email: string;
  amount: number;
  currency: string;
  status: string;
  stripe_created_at: string;
  source: string;
  metadata: Record<string, unknown>;
  raw_data: Record<string, unknown>;
}

interface ClientRecord {
  email: string;
  full_name: string | null;
  paypal_customer_id: string | null;
  lifecycle_stage: string;
  last_sync: string;
}

interface InvoiceRecord {
  stripe_invoice_id: string;
  invoice_number: string;
  status: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  customer_email: string | null;
  customer_name: string | null;
  stripe_created_at: string;
  period_end: string;
  billing_reason: string;
  description: string | null;
}

interface DateChunk {
  start: Date;
  end: Date;
  index: number;
  total: number;
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

async function getPayPalAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await retryWithBackoff(
    () => fetch("https://api-m.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }),
    { ...RETRY_CONFIGS.FAST, retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP] }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get PayPal access token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

function mapPayPalStatus(status: string, eventCode: string): string {
  const statusLower = status.toLowerCase();
  const eventLower = eventCode.toLowerCase();

  if (statusLower === 's' || statusLower === 'success' || statusLower === 'completed' || eventLower.includes('completed')) {
    return 'paid';
  }
  if (statusLower === 'd' || statusLower === 'denied' || statusLower === 'failed' ||
    statusLower === 'r' || statusLower === 'reversed' || statusLower === 'refunded') {
    return 'failed';
  }
  if (statusLower === 'p' || statusLower === 'pending') {
    return 'pending';
  }
  return 'pending';
}

function formatPayPalDate(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Split a date range into chunks of MAX_DAYS_PER_CHUNK days
 * PayPal API only allows 31-day ranges maximum
 */
function splitIntoChunks(startDate: Date, endDate: Date): DateChunk[] {
  const chunks: DateChunk[] = [];
  let currentStart = new Date(startDate);
  const finalEnd = new Date(endDate);
  
  while (currentStart < finalEnd) {
    const chunkEnd = new Date(currentStart.getTime() + MAX_DAYS_PER_CHUNK * 24 * 60 * 60 * 1000);
    const actualEnd = chunkEnd > finalEnd ? finalEnd : chunkEnd;
    
    chunks.push({
      start: new Date(currentStart),
      end: actualEnd,
      index: chunks.length,
      total: 0 // Will be updated after all chunks are created
    });
    
    currentStart = new Date(actualEnd.getTime() + 1000); // +1 second to avoid overlap
  }
  
  // Update total count
  chunks.forEach(c => c.total = chunks.length);
  
  return chunks;
}

async function fetchPayPalPage(
  accessToken: string,
  startDate: string,
  endDate: string,
  page: number = 1
): Promise<PayPalPageResult> {
  const url = new URL("https://api-m.paypal.com/v1/reporting/transactions");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("page_size", "100");
  url.searchParams.set("page", String(page));
  url.searchParams.set("fields", "transaction_info,payer_info,cart_info");

  logger.info("Fetching PayPal transactions", { startDate, endDate, page });

  const response = await retryWithBackoff(
    () => fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }),
    { ...RETRY_CONFIGS.STANDARD, retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP] }
  );

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 404 || error.includes("NO_DATA")) {
      return { transactions: [], totalPages: 0, totalItems: 0 };
    }
    throw new Error(`PayPal API error: ${error.substring(0, 200)}`);
  }

  const data = await response.json();
  return {
    transactions: data.transaction_details || [],
    totalPages: data.total_pages || 1,
    totalItems: data.total_items || 0
  };
}

// ============= AUTO-CONTINUATION =============

async function triggerNextChunkOrPage(
  supabase: SupabaseClient,
  syncRunId: string,
  nextPage: number,
  chunkStart: string,
  chunkEnd: string,
  chunkIndex: number,
  totalChunks: number,
  originalStartDate: string,
  originalEndDate: string,
  totalPages: number
): Promise<boolean> {
  const { data: updated, error } = await supabase
    .from('sync_runs')
    .update({
      checkpoint: {
        page: nextPage,
        chunkIndex,
        chunkStart,
        chunkEnd,
        totalChunks,
        totalPages,
        lastActivity: new Date().toISOString()
      }
    })
    .eq('id', syncRunId)
    .eq('status', 'continuing')
    .select('id')
    .single();

  if (error || !updated) {
    logger.warn(`Continuation lock failed`, { syncRunId, nextPage, chunkIndex, error: error?.message });
    return false;
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  fetch(`${supabaseUrl}/functions/v1/fetch-paypal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`
    },
    body: JSON.stringify({
      fetchAll: true,
      syncRunId,
      page: nextPage,
      chunkIndex,
      chunkStart,
      chunkEnd,
      totalChunks,
      originalStartDate,
      originalEndDate,
      _continuation: true
    })
  }).catch(err => logger.error('Auto-continuation fetch failed', err));

  logger.info(`✅ Triggered continuation: chunk ${chunkIndex + 1}/${totalChunks}, page ${nextPage}/${totalPages}`, { syncRunId });
  return true;
}

// ============= MAIN HANDLER =============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const paypalClientId = Deno.env.get("PAYPAL_CLIENT_ID");
    const paypalSecret = Deno.env.get("PAYPAL_SECRET");

    if (!paypalClientId || !paypalSecret) {
      return new Response(
        JSON.stringify({ success: false, status: 'failed', error: "PayPal credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

    // ============= TEST ONLY MODE - Quick API verification =============
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body */ }

    if (body.testOnly === true) {
      logger.info('Test-only mode: Verifying PayPal API connection');
      try {
        const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret);
        
        logger.info('PayPal API test result: SUCCESS (got access token)');
        
        return new Response(JSON.stringify({
          ok: true,
          success: true,
          status: 'connected',
          apiStatus: 200,
          hasToken: true,
          error: null,
          testOnly: true
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (testError) {
        logger.error('PayPal API test failed', testError instanceof Error ? testError : new Error(String(testError)));
        return new Response(JSON.stringify({
          ok: false,
          success: false,
          status: 'error',
          error: testError instanceof Error ? testError.message : 'Connection failed',
          testOnly: true
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }
    // ================================================================

    // Parse request
    let originalStartDate: string;
    let originalEndDate: string;
    let chunkStart: string;
    let chunkEnd: string;
    let fetchAll = false;
    let page = 1;
    let chunkIndex = 0;
    let totalChunks = 1;
    let syncRunId: string | null = null;
    let cleanupStale = false;
    let forceCancel = false;
    let isContinuation = false;

    // Calculate safe date boundaries
    const nowMs = Date.now();
    const safeEndMs = nowMs - 10 * 60 * 1000; // 10 minute buffer
    const safeEndDate = new Date(safeEndMs);
    const threeYearsAgoMs = nowMs - (3 * 365 - 7) * 24 * 60 * 60 * 1000;
    const threeYearsAgo = new Date(threeYearsAgoMs);

    // Now use already-parsed body for remaining logic
    fetchAll = body.fetchAll === true;
    cleanupStale = body.cleanupStale === true;
    forceCancel = body.forceCancel === true;
    isContinuation = body._continuation === true;
    page = body.page || 1;
    chunkIndex = body.chunkIndex || 0;
    totalChunks = body.totalChunks || 1;
    syncRunId = body.syncRunId || null;

    // For continuations, use the chunk dates passed
    if (isContinuation && body.chunkStart && body.chunkEnd) {
      chunkStart = body.chunkStart;
      chunkEnd = body.chunkEnd;
      originalStartDate = body.originalStartDate || body.chunkStart;
      originalEndDate = body.originalEndDate || body.chunkEnd;
    } else {
      // Initial request - calculate the range
      let requestedStart: Date;
      let requestedEnd: Date;

      if (body.startDate) {
        requestedStart = new Date(body.startDate);
        if (requestedStart < threeYearsAgo) {
          requestedStart = threeYearsAgo;
        }
      } else {
        requestedStart = new Date(nowMs - 31 * 24 * 60 * 60 * 1000);
      }

      if (body.endDate) {
        const bodyEnd = new Date(body.endDate);
        requestedEnd = bodyEnd < safeEndDate ? bodyEnd : safeEndDate;
      } else {
        requestedEnd = safeEndDate;
      }

      originalStartDate = formatPayPalDate(requestedStart);
      originalEndDate = formatPayPalDate(requestedEnd);

      // Split into chunks if range > 31 days
      const rangeDays = (requestedEnd.getTime() - requestedStart.getTime()) / (24 * 60 * 60 * 1000);
      
      if (rangeDays > MAX_DAYS_PER_CHUNK) {
        const chunks = splitIntoChunks(requestedStart, requestedEnd);
        totalChunks = chunks.length;
        chunkIndex = 0;
        chunkStart = formatPayPalDate(chunks[0].start);
        chunkEnd = formatPayPalDate(chunks[0].end);
        logger.info(`📊 Large range detected: ${Math.round(rangeDays)} days → split into ${totalChunks} chunks of ${MAX_DAYS_PER_CHUNK} days`);
      } else {
        chunkStart = originalStartDate;
        chunkEnd = originalEndDate;
        totalChunks = 1;
      }
    }

    console.log(`📅 PayPal: chunk ${chunkIndex + 1}/${totalChunks}, page ${page}, range: ${chunkStart} → ${chunkEnd}`);

    // SECURITY: Verify JWT + admin role ONLY for non-continuation requests
    if (!isContinuation) {
      const authCheck = await verifyAdmin(req);
      if (!authCheck.valid) {
        return new Response(
          JSON.stringify({ success: false, status: 'failed', error: "Forbidden", message: authCheck.error }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ============ FORCE CANCEL ALL SYNCS ============
    if (forceCancel) {
      const { data: cancelledSyncs } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(), 
          error_message: 'Cancelado forzosamente por usuario' 
        })
        .eq('source', 'paypal')
        .in('status', ['running', 'continuing'])
        .select('id');

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
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();

      const { data: staleSyncs } = await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: `Timeout - sin actividad por ${STALE_TIMEOUT_MINUTES} minutos`
        })
        .eq('source', 'paypal')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold)
        .select('id');

      return new Response(
        JSON.stringify({ success: true, status: 'completed', cleaned: staleSyncs?.length || 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ CHECK FOR EXISTING SYNC ============
    if (!syncRunId && !isContinuation) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();

      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: `Timeout - sin actividad por ${STALE_TIMEOUT_MINUTES} minutos`
        })
        .eq('source', 'paypal')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold);

      const { data: existingRuns } = await supabase
        .from('sync_runs')
        .select('id')
        .eq('source', 'paypal')
        .in('status', ['running', 'continuing'])
        .limit(1);

      if (existingRuns && existingRuns.length > 0) {
        return new Response(
          JSON.stringify({
            success: false,
            status: 'failed',
            error: 'sync_already_running',
            message: 'Ya hay un sync de PayPal en progreso',
            existingSyncId: existingRuns[0].id
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Create sync run if needed
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'paypal',
          status: 'running',
          metadata: { 
            fetchAll, 
            originalStartDate, 
            originalEndDate,
            totalChunks,
            currentChunk: chunkIndex + 1
          }
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
      logger.info(`NEW PAYPAL SYNC RUN: ${syncRunId} (${totalChunks} chunks)`);
    } else {
      // Update progress
      await supabase
        .from('sync_runs')
        .update({
          status: 'running',
          metadata: { 
            fetchAll, 
            originalStartDate, 
            originalEndDate,
            totalChunks,
            currentChunk: chunkIndex + 1
          },
          checkpoint: { 
            page, 
            chunkIndex,
            totalChunks,
            lastActivity: new Date().toISOString() 
          }
        })
        .eq('id', syncRunId);
    }

    // Get access token
    let accessToken: string;
    try {
      accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Auth failed';
      logger.error('PayPal auth failed', error instanceof Error ? error : new Error(String(error)));
      await supabase
        .from('sync_runs')
        .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: errorMsg })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ success: false, status: 'failed', syncRunId, error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch transactions for current chunk
    let result: PayPalPageResult;
    try {
      result = await fetchPayPalPage(accessToken, chunkStart, chunkEnd, page);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Fetch failed';
      logger.error('PayPal fetch failed', error instanceof Error ? error : new Error(String(error)));
      await supabase
        .from('sync_runs')
        .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: errorMsg })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ success: false, status: 'failed', syncRunId, error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info(`PayPal chunk ${chunkIndex + 1}/${totalChunks}, page ${page}/${result.totalPages}: ${result.transactions.length} transactions`);

    // Process transactions
    let paidCount = 0;
    let failedCount = 0;
    const transactions: TransactionRecord[] = [];
    const clientsMap = new Map<string, ClientRecord>();
    const invoices: InvoiceRecord[] = [];

    for (const tx of result.transactions) {
      const info = tx.transaction_info;
      const payer = tx.payer_info;

      const email = payer?.email_address?.toLowerCase();
      if (!email) continue;

      const grossAmount = parseFloat(info.transaction_amount.value);
      const feeAmount = parseFloat(info.fee_amount?.value || '0');
      const currency = info.transaction_amount.currency_code?.toLowerCase() || 'usd';
      const status = mapPayPalStatus(info.transaction_status, info.transaction_event_code);

      if (status === 'paid') paidCount++;
      else if (status === 'failed') failedCount++;

      const fullName = payer?.payer_name
        ? `${payer.payer_name.given_name || ''} ${payer.payer_name.surname || ''}`.trim()
        : null;

      const productName = tx.cart_info?.item_details?.[0]?.item_name ||
        info.transaction_subject ||
        info.transaction_note || null;

      transactions.push({
        stripe_payment_intent_id: `paypal_${info.transaction_id}`,
        payment_key: info.transaction_id,
        external_transaction_id: info.transaction_id,
        customer_email: email,
        amount: Math.round(Math.abs(grossAmount) * 100),
        currency,
        status,
        stripe_created_at: info.transaction_initiation_date,
        source: 'paypal',
        metadata: {
          event_code: info.transaction_event_code,
          customer_name: fullName,
          product_name: productName,
          paypal_payer_id: payer?.account_id,
          gross_amount: Math.round(Math.abs(grossAmount) * 100),
          fee_amount: Math.round(Math.abs(feeAmount) * 100)
        },
        raw_data: tx as unknown as Record<string, unknown>
      });

      // Map PayPal status to invoice status
      const invoiceStatus = status === 'paid' ? 'paid' : status === 'pending' ? 'open' : 'void';
      const amountCents = Math.round(Math.abs(grossAmount) * 100);

      invoices.push({
        stripe_invoice_id: `paypal_${info.transaction_id}`,
        invoice_number: `PAYPAL-${info.transaction_id}`,
        status: invoiceStatus,
        amount_due: amountCents,
        amount_paid: invoiceStatus === 'paid' ? amountCents : 0,
        amount_remaining: invoiceStatus === 'paid' ? 0 : amountCents,
        currency,
        customer_email: email,
        customer_name: fullName,
        stripe_created_at: info.transaction_initiation_date,
        period_end: info.transaction_initiation_date,
        billing_reason: 'paypal_transaction',
        description: productName
      });

      if (!clientsMap.has(email)) {
        clientsMap.set(email, {
          email,
          full_name: fullName,
          paypal_customer_id: payer?.account_id || null,
          lifecycle_stage: status === 'paid' ? 'CUSTOMER' : 'LEAD',
          last_sync: new Date().toISOString()
        });
      }
    }

    // Save to database
    let transactionsSaved = 0;
    let clientsSaved = 0;
    let invoicesSaved = 0;

    if (transactions.length > 0) {
      const { data } = await supabase
        .from('transactions')
        .upsert(transactions, { onConflict: 'stripe_payment_intent_id', ignoreDuplicates: false })
        .select('id');
      transactionsSaved = data?.length || 0;
    }

    const clientsToSave = Array.from(clientsMap.values());
    if (clientsToSave.length > 0) {
      const { data } = await supabase
        .from('clients')
        .upsert(clientsToSave, { onConflict: 'email', ignoreDuplicates: false })
        .select('id');
      clientsSaved = data?.length || 0;
    }

    // Save PayPal invoices
    if (invoices.length > 0) {
      const { data, error: invoicesError } = await supabase
        .from('invoices')
        .upsert(invoices, { onConflict: 'stripe_invoice_id', ignoreDuplicates: false })
        .select('id');
      
      if (invoicesError) {
        logger.warn('Error upserting invoices', { error: invoicesError.message });
      } else {
        invoicesSaved = data?.length || 0;
      }
    }

    // Check if more pages in current chunk
    const hasMorePagesInChunk = page < result.totalPages;
    // Check if more chunks after this one
    const hasMoreChunks = chunkIndex < totalChunks - 1;
    const hasMore = fetchAll && (hasMorePagesInChunk || hasMoreChunks);

    if (hasMore) {
      // INCREMENTAL COUNTERS
      const { data: currentRun } = await supabase
        .from('sync_runs')
        .select('total_fetched, total_inserted, checkpoint')
        .eq('id', syncRunId)
        .single();

      const accumulatedFetched = (currentRun?.total_fetched || 0) + transactionsSaved;
      const accumulatedInserted = (currentRun?.total_inserted || 0) + transactionsSaved;

      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: accumulatedFetched,
          total_inserted: accumulatedInserted,
          metadata: { 
            fetchAll, 
            originalStartDate, 
            originalEndDate,
            totalChunks,
            currentChunk: chunkIndex + 1,
            currentPage: page,
            totalPagesInChunk: result.totalPages
          }
        })
        .eq('id', syncRunId);

      // Determine next step: next page in same chunk, or first page of next chunk
      let nextPage: number;
      let nextChunkIndex: number;
      let nextChunkStart: string;
      let nextChunkEnd: string;

      if (hasMorePagesInChunk) {
        // More pages in current chunk
        nextPage = page + 1;
        nextChunkIndex = chunkIndex;
        nextChunkStart = chunkStart;
        nextChunkEnd = chunkEnd;
      } else {
        // Move to next chunk
        nextPage = 1;
        nextChunkIndex = chunkIndex + 1;
        
        // Recalculate chunk dates
        const startDate = new Date(originalStartDate);
        const endDate = new Date(originalEndDate);
        const chunks = splitIntoChunks(startDate, endDate);
        nextChunkStart = formatPayPalDate(chunks[nextChunkIndex].start);
        nextChunkEnd = formatPayPalDate(chunks[nextChunkIndex].end);
        
        logger.info(`📦 Moving to next chunk: ${nextChunkIndex + 1}/${totalChunks} (${nextChunkStart} → ${nextChunkEnd})`);
      }

      await triggerNextChunkOrPage(
        supabase,
        syncRunId!,
        nextPage,
        nextChunkStart,
        nextChunkEnd,
        nextChunkIndex,
        totalChunks,
        originalStartDate,
        originalEndDate,
        result.totalPages
      );

      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          syncRunId,
          synced_transactions: transactionsSaved,
          synced_clients: clientsSaved,
          paid_count: paidCount,
          failed_count: failedCount,
          hasMore: true,
          currentChunk: chunkIndex + 1,
          totalChunks,
          currentPage: page,
          totalPages: result.totalPages,
          duration_ms: Date.now() - startTime
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Complete
    const { data: finalRun } = await supabase
      .from('sync_runs')
      .select('total_fetched, total_inserted')
      .eq('id', syncRunId)
      .single();

    const finalFetched = (finalRun?.total_fetched || 0) + transactionsSaved;
    const finalInserted = (finalRun?.total_inserted || 0) + transactionsSaved;

    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: finalFetched,
        total_inserted: finalInserted,
        checkpoint: null
      })
      .eq('id', syncRunId);

    logger.info(`PAYPAL SYNC COMPLETE: ${finalFetched} total transactions across ${totalChunks} chunks in ${Date.now() - startTime}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId,
        synced_transactions: finalFetched,
        synced_clients: clientsSaved,
        paid_count: paidCount,
        failed_count: failedCount,
        totalChunks,
        hasMore: false,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Fatal error", error instanceof Error ? error : new Error(String(error)));

    return new Response(
      JSON.stringify({ success: false, status: 'failed', error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
