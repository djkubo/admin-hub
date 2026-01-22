import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SECURITY: Simple admin key guard
function verifyAdminKey(req: Request): { valid: boolean; error?: string } {
  const adminKey = Deno.env.get("ADMIN_API_KEY");
  if (!adminKey) {
    return { valid: false, error: "ADMIN_API_KEY not configured" };
  }
  const providedKey = req.headers.get("x-admin-key");
  if (!providedKey || providedKey !== adminKey) {
    return { valid: false, error: "Invalid or missing x-admin-key" };
  }
  return { valid: true };
}

interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PayPalFeeInfo {
  paypal_fee?: {
    currency_code?: string;
    value?: string;
  };
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
    fee_amount?: {
      currency_code?: string;
      value?: string;
    };
    transaction_status: string;
    payer_info?: {
      email_address?: string;
      account_id?: string;
      payer_name?: {
        given_name?: string;
        surname?: string;
      };
    };
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
      item_quantity?: string;
      item_unit_price?: {
        currency_code?: string;
        value?: string;
      };
    }>;
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

// Mapeo de códigos de evento PayPal a descripciones legibles
const PAYPAL_EVENT_DESCRIPTIONS: Record<string, string> = {
  'T0000': 'General: PayPal account to PayPal account payment',
  'T0001': 'Mass payment',
  'T0002': 'Subscription payment',
  'T0003': 'Pre-approved payment',
  'T0004': 'eBay auction payment',
  'T0005': 'Direct payment',
  'T0006': 'Express Checkout payment',
  'T0007': 'Website payment',
  'T0008': 'Postage payment',
  'T0009': 'Gift certificate',
  'T0010': 'Third-party auction payment',
  'T0011': 'Mobile payment',
  'T0012': 'Virtual terminal payment',
  'T1107': 'Payment refund',
  'T1201': 'Chargeback',
};

// Generate 31-day chunks for PayPal API (which has 31-day max range limit)
function generateDateChunks(startDate: Date, endDate: Date): Array<{start: Date, end: Date}> {
  const chunks: Array<{start: Date, end: Date}> = [];
  const CHUNK_DAYS = 30; // Use 30 to be safe (PayPal limit is 31)
  
  let currentStart = new Date(startDate);
  
  while (currentStart < endDate) {
    const chunkEnd = new Date(currentStart.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000);
    const actualEnd = chunkEnd > endDate ? endDate : chunkEnd;
    
    chunks.push({
      start: new Date(currentStart),
      end: new Date(actualEnd)
    });
    
    currentStart = new Date(actualEnd.getTime() + 1); // Move to next chunk
  }
  
  return chunks;
}

async function fetchPayPalChunk(
  accessToken: string,
  startDate: string,
  endDate: string,
  fetchAll: boolean
): Promise<PayPalTransaction[]> {
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
        console.log(`No transactions found in chunk ${startDate} - ${endDate}`);
        break;
      }
      
      console.error(`PayPal API error for chunk ${startDate} - ${endDate}:`, error);
      throw new Error(`PayPal API error: ${error}`);
    }

    const data: PayPalSearchResponse = await response.json();
    
    if (data.transaction_details) {
      allTransactions = allTransactions.concat(data.transaction_details);
    }
    
    totalPages = data.total_pages || 1;
    console.log(`  📄 Page ${currentPage}/${totalPages}: ${data.transaction_details?.length || 0} transactions`);
    
    currentPage++;
  }

  return allTransactions;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify x-admin-key
    const authCheck = verifyAdminKey(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Admin key verified");

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

    let startDate: Date;
    let endDate: Date;
    let fetchAll = false;

    // PayPal API limit: max 3 years of history
    const now = new Date();
    const threeYearsAgo = new Date(now.getTime() - (3 * 365 - 7) * 24 * 60 * 60 * 1000);

    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate && body.endDate) {
        let requestedStart = new Date(body.startDate);
        // Enforce PayPal's 3-year limit
        if (requestedStart < threeYearsAgo) {
          console.log(`⚠️ Requested start ${body.startDate} exceeds PayPal 3-year limit, clamping to ${threeYearsAgo.toISOString()}`);
          requestedStart = threeYearsAgo;
        }
        startDate = requestedStart;
        endDate = new Date(body.endDate);
      } else {
        // Default: last 31 days
        startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        endDate = now;
      }
    } catch {
      startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      endDate = now;
    }

    console.log(`🔄 PayPal Sync - from ${startDate.toISOString()} to ${endDate.toISOString()}, fetchAll: ${fetchAll}`);

    // Create sync_run record
    const { data: syncRun } = await supabase
      .from('sync_runs')
      .insert({
        source: 'paypal',
        status: 'running',
        metadata: { fetchAll, startDate: startDate.toISOString(), endDate: endDate.toISOString() }
      })
      .select('id')
      .single();
    
    const syncRunId = syncRun?.id;

    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret);
    console.log("✅ Got PayPal access token");

    // Generate 30-day chunks to respect PayPal's 31-day limit
    const dateChunks = generateDateChunks(startDate, endDate);
    console.log(`📅 Split into ${dateChunks.length} chunks of max 30 days each`);

    let allTransactions: PayPalTransaction[] = [];

    for (let i = 0; i < dateChunks.length; i++) {
      const chunk = dateChunks[i];
      console.log(`🔄 Chunk ${i + 1}/${dateChunks.length}: ${chunk.start.toISOString().split('T')[0]} → ${chunk.end.toISOString().split('T')[0]}`);
      
      try {
        const chunkTransactions = await fetchPayPalChunk(
          accessToken,
          chunk.start.toISOString(),
          chunk.end.toISOString(),
          fetchAll
        );
        allTransactions = allTransactions.concat(chunkTransactions);
        console.log(`  ✅ Chunk ${i + 1}: ${chunkTransactions.length} transactions (total: ${allTransactions.length})`);
      } catch (error) {
        console.error(`  ❌ Chunk ${i + 1} failed:`, error);
        // Continue with next chunk instead of failing completely
      }
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
      phone: string | null;
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
      
      if (transactionsMap.has(transactionId)) {
        skippedDuplicate++;
        continue;
      }

      const paymentIntentId = `paypal_${transactionId}`;

      const grossAmount = parseFloat(info.transaction_amount?.value || '0');
      const feeAmount = parseFloat(info.fee_amount?.value || '0');
      const netAmount = grossAmount - Math.abs(feeAmount);
      const currency = info.transaction_amount?.currency_code || 'USD';
      const status = mapPayPalStatus(info.transaction_status, info.transaction_event_code);
      
      const fullName = payer?.payer_name 
        ? `${payer.payer_name.given_name || ''} ${payer.payer_name.surname || ''}`.trim()
        : null;
      
      const payerId = payer?.account_id || null;

      // Get product info from cart
      let productName: string | null = null;
      if (tx.cart_info?.item_details?.[0]) {
        productName = tx.cart_info.item_details[0].item_name || 
                      tx.cart_info.item_details[0].item_description || null;
      }
      
      // Fallback to transaction subject/note
      if (!productName) {
        productName = info.transaction_subject || info.transaction_note || null;
      }

      // Get event description
      const eventDescription = PAYPAL_EVENT_DESCRIPTIONS[info.transaction_event_code] || null;

      if (status === 'paid') {
        paidCount++;
      } else if (status === 'failed') {
        failedCount++;
      }

      // Build enriched metadata
      const enrichedMetadata: Record<string, unknown> = { 
        event_code: info.transaction_event_code,
        event_description: eventDescription,
        original_status: info.transaction_status,
        customer_name: fullName,
        paypal_payer_id: payerId,
        gross_amount: Math.round(Math.abs(grossAmount) * 100),
        fee_amount: Math.round(Math.abs(feeAmount) * 100),
        net_amount: Math.round(Math.abs(netAmount) * 100),
        product_name: productName,
      };

      // Remove null values from metadata
      Object.keys(enrichedMetadata).forEach(key => {
        if (enrichedMetadata[key] === null || enrichedMetadata[key] === undefined) {
          delete enrichedMetadata[key];
        }
      });

      transactionsMap.set(transactionId, {
        stripe_payment_intent_id: paymentIntentId,
        payment_key: transactionId,
        external_transaction_id: transactionId,
        customer_email: email,
        amount: Math.round(Math.abs(grossAmount) * 100),
        currency: currency.toLowerCase(),
        status,
        failure_code: status === 'failed' ? info.transaction_status : null,
        failure_message: status === 'failed' ? `PayPal status: ${info.transaction_status}` : null,
        stripe_created_at: info.transaction_initiation_date,
        source: 'paypal',
        metadata: enrichedMetadata,
      });

      const existing = clientsMap.get(email) || { 
        email, 
        full_name: fullName,
        phone: null as string | null,
        payment_status: 'none', 
        total_paid: 0 
      };
      
      if (status === 'paid' && grossAmount > 0) {
        existing.payment_status = 'paid';
        existing.total_paid += Math.abs(grossAmount);
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
      phone: c.phone,
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
          metadata: { 
            fetchAll, 
            startDate: startDate.toISOString(), 
            endDate: endDate.toISOString(), 
            paidCount, 
            failedCount,
            chunks: dateChunks.length 
          }
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
        date_range: { start: startDate.toISOString(), end: endDate.toISOString() },
        chunks_processed: dateChunks.length,
        sync_run_id: syncRunId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
