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

// Generate 30-day chunks for PayPal API (which has 31-day max range limit)
function generateDateChunks(startDate: Date, endDate: Date): Array<{start: Date, end: Date}> {
  const chunks: Array<{start: Date, end: Date}> = [];
  const CHUNK_DAYS = 30;
  
  let currentStart = new Date(startDate);
  
  while (currentStart < endDate) {
    const chunkEnd = new Date(currentStart.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000);
    const actualEnd = chunkEnd > endDate ? endDate : chunkEnd;
    
    chunks.push({
      start: new Date(currentStart),
      end: new Date(actualEnd)
    });
    
    currentStart = new Date(actualEnd.getTime() + 1);
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

// ============ TRIGGER NEXT PAGE (BLOCKING - await response) ============
async function triggerNextPage(
  supabaseUrl: string,
  adminKey: string,
  body: Record<string, unknown>
): Promise<boolean> {
  try {
    console.log(`🚀 TRIGGERING PAYPAL NEXT CHUNK...`);
    const response = await fetch(`${supabaseUrl}/functions/v1/fetch-paypal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey,
      },
      body: JSON.stringify(body),
    });
    console.log(`✅ PayPal next chunk triggered: ${response.status}`);
    return response.ok || response.status === 202;
  } catch (err) {
    console.error(`❌ Failed to trigger PayPal next chunk:`, err);
    return false;
  }
}

// Max chunks per invocation to avoid timeout
const MAX_CHUNKS_PER_INVOCATION = 3;
// Stale timeout in minutes
const STALE_TIMEOUT_MINUTES = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

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
    const adminKey = Deno.env.get("ADMIN_API_KEY")!;
    
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
    let continuationChunkIndex = 0;
    let continuationSyncRunId: string | null = null;
    let continuationTotalSynced = 0;
    let continuationTotalClients = 0;
    let continuationPaidCount = 0;
    let continuationFailedCount = 0;

    // PayPal API limit: max 3 years of history
    const now = new Date();
    const threeYearsAgo = new Date(now.getTime() - (3 * 365 - 7) * 24 * 60 * 60 * 1000);

    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate && body.endDate) {
        let requestedStart = new Date(body.startDate);
        if (requestedStart < threeYearsAgo) {
          console.log(`⚠️ Requested start ${body.startDate} exceeds PayPal 3-year limit, clamping`);
          requestedStart = threeYearsAgo;
        }
        startDate = requestedStart;
        endDate = new Date(body.endDate);
      } else {
        startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        endDate = now;
      }
      
      // Continuation params
      if (body._continuation) {
        continuationChunkIndex = body._continuation.chunkIndex || 0;
        continuationSyncRunId = body._continuation.syncRunId || null;
        continuationTotalSynced = body._continuation.totalSynced || 0;
        continuationTotalClients = body._continuation.totalClients || 0;
        continuationPaidCount = body._continuation.paidCount || 0;
        continuationFailedCount = body._continuation.failedCount || 0;
        console.log(`🔄 CONTINUATION from chunk ${continuationChunkIndex}`);
      }
    } catch {
      startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      endDate = now;
    }

    console.log(`🔄 PayPal Sync - from ${startDate.toISOString()} to ${endDate.toISOString()}, fetchAll: ${fetchAll}`);

    // ============ CHECK FOR EXISTING RUNNING/CONTINUING SYNC ============
    if (!continuationSyncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      // Check for existing active sync
      const { data: existingRuns } = await supabase
        .from('sync_runs')
        .select('id, status, started_at, checkpoint')
        .eq('source', 'paypal')
        .in('status', ['running', 'continuing'])
        .order('started_at', { ascending: false })
        .limit(1);

      if (existingRuns && existingRuns.length > 0) {
        const existingRun = existingRuns[0];
        
        // Check if stale
        if (existingRun.started_at < staleThreshold) {
          console.log(`⏰ Marking stale sync ${existingRun.id} as failed`);
          await supabase
            .from('sync_runs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: 'Stale/timeout - no heartbeat for 30 minutes'
            })
            .eq('id', existingRun.id);
        } else {
          // Resume existing sync instead of creating new one
          console.log(`📍 Resuming existing sync ${existingRun.id}`);
          const checkpoint = existingRun.checkpoint as Record<string, unknown> || {};
          continuationSyncRunId = existingRun.id;
          continuationChunkIndex = (checkpoint.chunkIndex as number) || 0;
          continuationTotalSynced = (checkpoint.totalSynced as number) || 0;
          continuationTotalClients = (checkpoint.totalClients as number) || 0;
        }
      }
    }

    // Create or reuse sync_run record
    let syncRunId = continuationSyncRunId;
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'paypal',
          status: 'running',
          metadata: { fetchAll, startDate: startDate.toISOString(), endDate: endDate.toISOString() }
        })
        .select('id')
        .single();
      
      if (syncError) {
        console.error("Failed to create sync_run:", syncError);
        return new Response(
          JSON.stringify({ error: "Failed to create sync record", details: syncError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      syncRunId = syncRun?.id;
      console.log(`📊 NEW PAYPAL SYNC RUN: ${syncRunId}`);
    }

    const accessToken = await getPayPalAccessToken(paypalClientId, paypalSecret);
    console.log("✅ Got PayPal access token");

    // Generate 30-day chunks
    const dateChunks = generateDateChunks(startDate, endDate);
    console.log(`📅 Total ${dateChunks.length} chunks, starting from chunk ${continuationChunkIndex}`);

    let allTransactions: PayPalTransaction[] = [];
    let chunksProcessed = 0;
    const maxChunksThisInvocation = Math.min(MAX_CHUNKS_PER_INVOCATION, dateChunks.length - continuationChunkIndex);

    for (let i = continuationChunkIndex; i < dateChunks.length && chunksProcessed < maxChunksThisInvocation; i++) {
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
        chunksProcessed++;
      } catch (error) {
        console.error(`  ❌ Chunk ${i + 1} failed:`, error);
      }
    }

    const currentChunkIndex = continuationChunkIndex + chunksProcessed;
    console.log(`✅ Fetched ${allTransactions.length} transactions from ${chunksProcessed} chunks`);

    // Process transactions
    let paidCount = continuationPaidCount;
    let failedCount = continuationFailedCount;
    let skippedNoEmail = 0;
    let skippedDuplicate = 0;

    const transactionsMap = new Map<string, Record<string, unknown>>();
    const clientsMap = new Map<string, Record<string, unknown>>();

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

      let productName: string | null = null;
      if (tx.cart_info?.item_details?.[0]) {
        productName = tx.cart_info.item_details[0].item_name || 
                      tx.cart_info.item_details[0].item_description || null;
      }
      
      if (!productName) {
        productName = info.transaction_subject || info.transaction_note || null;
      }

      const eventDescription = PAYPAL_EVENT_DESCRIPTIONS[info.transaction_event_code] || null;

      if (status === 'paid') {
        paidCount++;
      } else if (status === 'failed') {
        failedCount++;
      }

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

      const existing = clientsMap.get(email) as Record<string, unknown> || { 
        email, 
        full_name: fullName,
        phone: null,
        payment_status: 'none', 
        total_paid: 0 
      };
      
      if (status === 'paid' && grossAmount > 0) {
        existing.payment_status = 'paid';
        existing.total_paid = (existing.total_paid as number || 0) + Math.abs(grossAmount);
      } else if (status === 'failed' && existing.payment_status !== 'paid') {
        existing.payment_status = 'failed';
      }
      
      if (fullName && !existing.full_name) {
        existing.full_name = fullName;
      }
      
      clientsMap.set(email, existing);
    }

    const transactions = Array.from(transactionsMap.values());
    console.log(`📊 Stats: ${paidCount} paid, ${failedCount} failed, ${skippedNoEmail} no email, ${skippedDuplicate} duplicates`);

    // Save to DB
    let syncedCount = continuationTotalSynced;
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

    let clientsSynced = continuationTotalClients;
    for (let i = 0; i < clientsToUpsert.length; i += BATCH_SIZE) {
      const batch = clientsToUpsert.slice(i, i + BATCH_SIZE);
      const { data: clientData, error: clientError } = await supabase
        .from("clients")
        .upsert(batch, { onConflict: "email", ignoreDuplicates: false })
        .select();

      if (!clientError) {
        clientsSynced += clientData?.length || 0;
      }
    }

    // ============ DECIDE: CONTINUE OR COMPLETE ============
    const needsContinuation = currentChunkIndex < dateChunks.length;

    if (needsContinuation && syncRunId) {
      console.log(`🔄 Continuing: ${currentChunkIndex}/${dateChunks.length} chunks done...`);
      
      // Update status to 'continuing' with heartbeat
      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: syncedCount + skippedNoEmail,
          total_inserted: syncedCount,
          total_skipped: skippedNoEmail,
          checkpoint: { 
            chunkIndex: currentChunkIndex, 
            chunksTotal: dateChunks.length,
            totalSynced: syncedCount,
            totalClients: clientsSynced,
            paidCount,
            failedCount,
            lastHeartbeat: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      // ============ CRITICAL: TRIGGER NEXT CHUNK BEFORE RETURNING ============
      const triggered = await triggerNextPage(supabaseUrl, adminKey, {
        fetchAll,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        _continuation: {
          chunkIndex: currentChunkIndex,
          syncRunId,
          totalSynced: syncedCount,
          totalClients: clientsSynced,
          paidCount,
          failedCount
        }
      });

      if (!triggered) {
        // Failed to trigger - mark as failed
        await supabase
          .from('sync_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Failed to trigger next chunk continuation'
          })
          .eq('id', syncRunId);
      }

      const duration = Date.now() - startTime;
      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          syncRunId,
          chunksCompleted: currentChunkIndex,
          chunksTotal: dateChunks.length,
          totalSynced: syncedCount,
          totalClients: clientsSynced,
          hasMore: true,
          duration_ms: duration,
          message: `Processed ${chunksProcessed} chunks (${syncedCount} total). Continuing...`
        }),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ SYNC COMPLETE ============
    if (syncRunId) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          total_fetched: syncedCount + skippedNoEmail,
          total_inserted: syncedCount,
          total_skipped: skippedNoEmail,
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

    const duration = Date.now() - startTime;
    console.log(`🎉 PAYPAL SYNC COMPLETE: ${syncedCount} transactions, ${clientsSynced} clients in ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId,
        synced_transactions: syncedCount,
        synced_clients: clientsSynced,
        chunks: dateChunks.length,
        paidCount,
        failedCount,
        skippedNoEmail,
        skippedDuplicate,
        hasMore: false,
        duration_ms: duration
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
