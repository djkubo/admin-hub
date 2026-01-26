import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const logger = createLogger('fetch-paypal', LogLevel.INFO);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ... interfaces ...

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

  // Retry token fetch
  const response = await retryWithBackoff(
    () => fetch("https://api-m.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }),
    {
      ...RETRY_CONFIGS.FAST,
      retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP]
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get PayPal access token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

function mapPayPalStatus(status: string, eventCode: string): string {
  // ... (keep same logic)
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
    {
      ...RETRY_CONFIGS.STANDARD,
      retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.HTTP]
    }
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

function formatPayPalDate(date: Date): string {
  // PayPal requires ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ (no milliseconds)
  const iso = date.toISOString();
  // Remove milliseconds, keep Z
  return iso.replace(/\.\d{3}Z$/, 'Z');
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
        JSON.stringify({ success: false, status: 'failed', error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    // Parse request
    let startDate: string;
    let endDate: string;
    let fetchAll = false;
    let page = 1;
    let syncRunId: string | null = null;
    let cleanupStale = false;

    // Calculate safe date boundaries BEFORE processing request
    // PayPal API STRICTLY rejects future dates - must use past timestamp
    const nowMs = Date.now();
    // Use 10 minutes buffer to account for clock skew and API processing time
    const safeEndMs = nowMs - 10 * 60 * 1000;
    const safeEndDate = new Date(safeEndMs);
    const threeYearsAgoMs = nowMs - (3 * 365 - 7) * 24 * 60 * 60 * 1000;
    const threeYearsAgo = new Date(threeYearsAgoMs);

    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      cleanupStale = body.cleanupStale === true;
      page = body.page || 1;
      syncRunId = body.syncRunId || null;

      if (body.startDate) {
        let requestedStart = new Date(body.startDate);
        if (requestedStart < threeYearsAgo) {
          requestedStart = threeYearsAgo;
        }
        startDate = formatPayPalDate(requestedStart);
      } else {
        // Default: 31 days ago
        startDate = formatPayPalDate(new Date(nowMs - 31 * 24 * 60 * 60 * 1000));
      }

      // CRITICAL: Always cap end_date to safe past timestamp
      // Never trust client-provided endDate - always enforce server-side cap
      if (body.endDate) {
        const requestedEnd = new Date(body.endDate);
        // Always use the earlier of: requested date OR safe end date
        endDate = formatPayPalDate(requestedEnd < safeEndDate ? requestedEnd : safeEndDate);
      } else {
        endDate = formatPayPalDate(safeEndDate);
      }
    } catch {
      // Default range if no body: last 31 days
      startDate = formatPayPalDate(new Date(nowMs - 31 * 24 * 60 * 60 * 1000));
      endDate = formatPayPalDate(safeEndDate);
    }

    console.log(`📅 PayPal date range: ${startDate} → ${endDate}`);

    // ============ CLEANUP STALE SYNCS ============
    if (cleanupStale) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();

      const { data: staleSyncs } = await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Timeout - sin actividad por 30 minutos'
        })
        .eq('source', 'paypal')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold)
        .select('id');

      return new Response(
        JSON.stringify({ success: true, status: 'completed', cleaned: staleSyncs?.length || 0, duration_ms: Date.now() - startTime }),
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
      logger.info(`NEW PAYPAL SYNC RUN: ${syncRunId}`);
    } else {
      await supabase
        .from('sync_runs')
        .update({
          status: 'running',
          checkpoint: { page, lastActivity: new Date().toISOString() }
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
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: errorMsg
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ success: false, status: 'failed', syncRunId, error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch transactions
    let result: PayPalPageResult;
    try {
      result = await fetchPayPalPage(accessToken, startDate, endDate, page);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Fetch failed';
      logger.error('PayPal fetch failed', error instanceof Error ? error : new Error(String(error)));
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: errorMsg
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ success: false, status: 'failed', syncRunId, error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info(`PayPal page ${page}/${result.totalPages}: ${result.transactions.length} transactions`);

    // Process transactions
    let paidCount = 0;
    let failedCount = 0;
    const transactions: TransactionRecord[] = [];
    const clientsMap = new Map<string, ClientRecord>();

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

    // Check if more pages
    const hasMore = fetchAll && page < result.totalPages;

    if (hasMore) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: transactionsSaved,
          total_inserted: transactionsSaved,
          checkpoint: {
            page,
            totalPages: result.totalPages,
            lastActivity: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

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
          currentPage: page,
          totalPages: result.totalPages,
          nextPage: page + 1,
          duration_ms: Date.now() - startTime
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Complete
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: transactionsSaved,
        total_inserted: transactionsSaved,
        checkpoint: null
      })
      .eq('id', syncRunId);

    logger.info(`PAYPAL SYNC COMPLETE: ${transactionsSaved} transactions in ${Date.now() - startTime}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId,
        synced_transactions: transactionsSaved,
        synced_clients: clientsSaved,
        paid_count: paidCount,
        failed_count: failedCount,
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
