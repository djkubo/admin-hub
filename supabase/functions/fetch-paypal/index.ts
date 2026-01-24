import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SECURITY: JWT-based admin verification using getUser()
async function verifyAdmin(req: Request): Promise<{ valid: boolean; error?: string; userId?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  // Use getUser() instead of getClaims() for compatibility
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  
  if (userError || !user) {
    return { valid: false, error: 'Invalid or expired token' };
  }

  // Check if user is admin using RPC
  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  
  if (adminError || !isAdmin) {
    return { valid: false, error: 'User is not an admin' };
  }

  return { valid: true, userId: user.id };
}

// ============ CONFIGURATION ============
const STALE_TIMEOUT_MINUTES = 30;

interface PayPalTransaction {
  transaction_info: {
    transaction_id: string;
    transaction_event_code: string;
    transaction_initiation_date: string;
    transaction_amount: {
      currency_code: string;
      value: string;
    };
    fee_amount?: {
      value?: string;
    };
    transaction_status: string;
    transaction_note?: string;
    transaction_subject?: string;
  };
  payer_info?: {
    email_address?: string;
    account_id?: string;
    payer_name?: {
      given_name?: string;
      surname?: string;
    };
  };
  cart_info?: {
    item_details?: Array<{
      item_name?: string;
      item_description?: string;
    }>;
  };
}

async function getPayPalAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  
  const response = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

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

async function fetchPayPalPage(
  accessToken: string,
  startDate: string,
  endDate: string,
  page: number = 1
): Promise<{ transactions: PayPalTransaction[]; totalPages: number; totalItems: number }> {
  const url = new URL("https://api-m.paypal.com/v1/reporting/transactions");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("page_size", "100");
  url.searchParams.set("page", String(page));
  url.searchParams.set("fields", "transaction_info,payer_info,cart_info");

  const response = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

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
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const paypalClientId = Deno.env.get("PAYPAL_CLIENT_ID");
    const paypalSecret = Deno.env.get("PAYPAL_SECRET");
    
    if (!paypalClientId || !paypalSecret) {
      return new Response(
        JSON.stringify({ error: "PayPal credentials not configured" }),
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

    const now = new Date();
    const threeYearsAgo = new Date(now.getTime() - (3 * 365 - 7) * 24 * 60 * 60 * 1000);

    // PayPal requires dates in ISO 8601 format WITHOUT milliseconds: YYYY-MM-DDTHH:MM:SSZ
    const formatPayPalDate = (date: Date): string => {
      return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    };

    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      cleanupStale = body.cleanupStale === true;
      page = body.page || 1;
      syncRunId = body.syncRunId || null;
      
      if (body.startDate && body.endDate) {
        let requestedStart = new Date(body.startDate);
        if (requestedStart < threeYearsAgo) {
          requestedStart = threeYearsAgo;
        }
        startDate = formatPayPalDate(requestedStart);
        // Also format endDate to ensure consistent format
        endDate = formatPayPalDate(new Date(body.endDate));
      } else {
        startDate = formatPayPalDate(new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
        endDate = formatPayPalDate(now);
      }
    } catch {
      startDate = formatPayPalDate(new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
      endDate = formatPayPalDate(now);
    }

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
        JSON.stringify({ success: true, cleaned: staleSyncs?.length || 0 }),
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
          JSON.stringify({ error: "Failed to create sync record" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      syncRunId = syncRun?.id;
      console.log(`📊 NEW PAYPAL SYNC RUN: ${syncRunId}`);
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
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : 'Auth failed'
        })
        .eq('id', syncRunId);
      
      return new Response(
        JSON.stringify({ success: false, error: 'PayPal authentication failed' }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch transactions
    let result;
    try {
      result = await fetchPayPalPage(accessToken, startDate, endDate, page);
    } catch (error) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : 'Fetch failed'
        })
        .eq('id', syncRunId);
      
      return new Response(
        JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Failed' }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`📄 PayPal page ${page}/${result.totalPages}: ${result.transactions.length} transactions`);

    // Process transactions
    let paidCount = 0;
    let failedCount = 0;
    const transactions: Array<Record<string, unknown>> = [];
    const clientsMap = new Map<string, Record<string, unknown>>();

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

      let productName = tx.cart_info?.item_details?.[0]?.item_name || 
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
        }
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
          nextPage: page + 1
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

    console.log(`🎉 PAYPAL SYNC COMPLETE: ${transactionsSaved} transactions in ${Date.now() - startTime}ms`);

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
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
