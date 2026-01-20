import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://id-preview--9d074359-befd-41d0-9307-39b75ab20410.lovable.app",
  "https://lovable.dev",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.some(o => origin.startsWith(o.replace(/\/$/, ''))) 
    ? origin 
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PayPalTransaction {
  transaction_info: {
    transaction_id: string;
    transaction_event_code: string;
    transaction_initiation_date: string;
    transaction_updated_date: string;
    transaction_amount: {
      currency_code: string;
      value: string;
    };
    transaction_status: string;
    payer_info?: {
      email_address?: string;
      payer_name?: {
        given_name?: string;
        surname?: string;
      };
    };
  };
  payer_info?: {
    email_address?: string;
    payer_name?: {
      given_name?: string;
      surname?: string;
    };
  };
}

interface PayPalSearchResponse {
  transaction_details: PayPalTransaction[];
  page: number;
  total_pages: number;
  total_items: number;
  links: Array<{ rel: string; href: string }>;
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

  const data: PayPalTokenResponse = await response.json();
  return data.access_token;
}

function mapPayPalStatus(status: string, eventCode: string): string {
  const statusLower = status.toLowerCase();
  const eventLower = eventCode.toLowerCase();
  
  if (statusLower === 's' || statusLower === 'success' || statusLower === 'completed' || eventLower.includes('completed')) {
    return 'paid';
  }
  if (statusLower === 'd' || statusLower === 'denied' || statusLower === 'failed' || 
      statusLower === 'r' || statusLower === 'reversed' || statusLower === 'refunded' ||
      eventLower.includes('denied') || eventLower.includes('failed') || eventLower.includes('reversed')) {
    return 'failed';
  }
  if (statusLower === 'p' || statusLower === 'pending') {
    return 'pending';
  }
  return 'pending';
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getUser(token);
    
    if (claimsError || !claimsData?.user) {
      console.error("Auth error:", claimsError);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", claimsData.user.email);

    const paypalClientId = Deno.env.get("PAYPAL_CLIENT_ID");
    const paypalSecret = Deno.env.get("PAYPAL_SECRET");
    
    if (!paypalClientId || !paypalSecret) {
      return new Response(
        JSON.stringify({ error: "PayPal credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let startDate: string;
    let endDate: string;
    let fetchAll = false;

    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate && body.endDate) {
        startDate = body.startDate;
        endDate = body.endDate;
      } else {
        const now = new Date();
        const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        startDate = thirtyOneDaysAgo.toISOString();
        endDate = now.toISOString();
      }
    } catch {
      const now = new Date();
      const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      startDate = thirtyOneDaysAgo.toISOString();
      endDate = now.toISOString();
    }

    console.log(`🔄 PayPal Sync - from ${startDate} to ${endDate}, fetchAll: ${fetchAll}`);

    // Create sync_run record
    const { data: syncRun } = await supabase
      .from('sync_runs')
      .insert({
        source: 'paypal',
        status: 'running',
        metadata: { fetchAll, startDate, endDate }
      })
      .select('id')
      .single();
    
    const syncRunId = syncRun?.id;

    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret);
    console.log("✅ Got PayPal access token");

    let allTransactions: PayPalTransaction[] = [];
    let currentPage = 1;
    let totalPages = 1;
    const maxPages = fetchAll ? 100 : 1;

    while (currentPage <= totalPages && currentPage <= maxPages) {
      const url = new URL("https://api-m.paypal.com/v1/reporting/transactions");
      url.searchParams.set("start_date", startDate);
      url.searchParams.set("end_date", endDate);
      url.searchParams.set("page_size", "100");
      url.searchParams.set("page", String(currentPage));
      url.searchParams.set("fields", "transaction_info,payer_info");

      const response = await fetch(url.toString(), {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("PayPal API error:", error);
        
        if (response.status === 404 || error.includes("NO_DATA")) {
          console.log("No transactions found in date range");
          break;
        }
        
        return new Response(
          JSON.stringify({ error: "PayPal API error", details: error }),
          { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data: PayPalSearchResponse = await response.json();
      
      if (data.transaction_details) {
        allTransactions = allTransactions.concat(data.transaction_details);
      }
      
      totalPages = data.total_pages || 1;
      console.log(`📄 Page ${currentPage}/${totalPages}: ${data.transaction_details?.length || 0} transactions (total: ${allTransactions.length})`);
      
      currentPage++;
    }

    console.log(`✅ Fetched ${allTransactions.length} total transactions from PayPal`);

    let paidCount = 0;
    let failedCount = 0;
    let skippedNoEmail = 0;
    let skippedDuplicate = 0;

    const transactionsMap = new Map<string, {
      stripe_payment_intent_id: string;
      payment_key: string;
      external_transaction_id: string;
      customer_email: string;
      amount: number;
      currency: string;
      status: string;
      failure_code: string | null;
      failure_message: string | null;
      stripe_created_at: string;
      source: string;
      metadata: Record<string, unknown>;
    }>();

    const clientsMap = new Map<string, {
      email: string;
      full_name: string | null;
      payment_status: string;
      total_paid: number;
    }>();

    for (const tx of allTransactions) {
      const info = tx.transaction_info;
      const payer = tx.payer_info || info.payer_info;
      
      const email = payer?.email_address;
      if (!email) {
        skippedNoEmail++;
        continue;
      }

      const transactionId = info.transaction_id;
      
      // Check for duplicate using clean transaction ID (no prefix)
      if (transactionsMap.has(transactionId)) {
        skippedDuplicate++;
        continue;
      }

      const paymentIntentId = `paypal_${transactionId}`; // For backwards compat

      const amount = parseFloat(info.transaction_amount?.value || '0');
      const currency = info.transaction_amount?.currency_code || 'USD';
      const status = mapPayPalStatus(info.transaction_status, info.transaction_event_code);
      
      const fullName = payer?.payer_name 
        ? `${payer.payer_name.given_name || ''} ${payer.payer_name.surname || ''}`.trim()
        : null;

      if (status === 'paid') {
        paidCount++;
      } else if (status === 'failed') {
        failedCount++;
      }

      // NORMALIZED: payment_key = transaction_id (NO prefix) for perfect dedup
      transactionsMap.set(transactionId, {
        stripe_payment_intent_id: paymentIntentId, // Backwards compat with prefix
        payment_key: transactionId, // CANONICAL dedup key (NO prefix)
        external_transaction_id: transactionId, // Clean ID for reference
        customer_email: email,
        amount: Math.round(Math.abs(amount) * 100), // Convert dollars to cents
        currency: currency.toLowerCase(), // Normalize to lowercase
        status,
        failure_code: status === 'failed' ? info.transaction_status : null,
        failure_message: status === 'failed' ? `PayPal status: ${info.transaction_status}` : null,
        stripe_created_at: info.transaction_initiation_date,
        source: 'paypal',
        metadata: { 
          event_code: info.transaction_event_code,
          original_status: info.transaction_status 
        },
      });

      const existing = clientsMap.get(email) || { 
        email, 
        full_name: fullName,
        payment_status: 'none', 
        total_paid: 0 
      };
      
      if (status === 'paid' && amount > 0) {
        existing.payment_status = 'paid';
        existing.total_paid += Math.abs(amount);
      } else if (status === 'failed' && existing.payment_status !== 'paid') {
        existing.payment_status = 'failed';
      }
      
      if (fullName && !existing.full_name) {
        existing.full_name = fullName;
      }
      
      clientsMap.set(email, existing);
    }

    const transactions = Array.from(transactionsMap.values());

    console.log(`📊 Stats: ${paidCount} paid, ${failedCount} failed, ${skippedNoEmail} skipped (no email), ${skippedDuplicate} duplicates removed`);

    let syncedCount = 0;
    const BATCH_SIZE = 500;
    
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      // Use new UNIQUE constraint: (source, payment_key)
      const { data: upsertedData, error: upsertError } = await supabase
        .from("transactions")
        .upsert(batch, { onConflict: "source,payment_key", ignoreDuplicates: false })
        .select();

      if (upsertError) {
        console.error(`Error upserting batch ${i / BATCH_SIZE + 1}:`, upsertError);
      } else {
        syncedCount += upsertedData?.length || 0;
      }
    }

    const clientsToUpsert = Array.from(clientsMap.values()).map(c => ({
      email: c.email,
      full_name: c.full_name,
      payment_status: c.payment_status,
      total_paid: c.total_paid,
      last_sync: new Date().toISOString(),
      status: 'active'
    }));

    let clientsSynced = 0;
    for (let i = 0; i < clientsToUpsert.length; i += BATCH_SIZE) {
      const batch = clientsToUpsert.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("clients")
        .upsert(batch, { onConflict: "email", ignoreDuplicates: false });

      if (!error) {
        clientsSynced += batch.length;
      }
    }

    console.log(`✅ Synced ${syncedCount} transactions, ${clientsSynced} clients`);

    // Update sync_run record
    if (syncRunId) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          total_fetched: allTransactions.length,
          total_inserted: syncedCount,
          total_skipped: skippedNoEmail + skippedDuplicate,
          metadata: { fetchAll, startDate, endDate, paidCount, failedCount }
        })
        .eq('id', syncRunId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${syncedCount} transactions from PayPal`,
        synced_transactions: syncedCount,
        synced_clients: clientsSynced,
        paid_count: paidCount,
        failed_count: failedCount,
        skipped_no_email: skippedNoEmail,
        total_fetched: allTransactions.length,
        date_range: { start: startDate, end: endDate },
        sync_run_id: syncRunId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const origin = req.headers.get("origin");
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      { status: 500, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
