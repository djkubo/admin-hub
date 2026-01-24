import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SECURITY: Simple admin key guard
function verifyAdminKey(req: Request): { valid: boolean; error?: string } {
  const adminKey = Deno.env.get("ADMIN_API_KEY");
  const providedKey = req.headers.get("x-admin-key");
  
  if (!adminKey) {
    return { valid: false, error: "ADMIN_API_KEY not configured on server" };
  }
  if (!providedKey) {
    return { valid: false, error: "x-admin-key header not provided" };
  }
  if (providedKey !== adminKey) {
    return { valid: false, error: "x-admin-key does not match" };
  }
  return { valid: true };
}

// Mapeo de decline codes a español
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

// ============ CONFIGURATION ============
const RECORDS_PER_PAGE = 100;
const STRIPE_API_DELAY_MS = 50;
const STALE_TIMEOUT_MINUTES = 30;

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

// ============ TRIGGER NEXT PAGE (BLOCKING) ============
async function triggerNextPage(
  supabaseUrl: string,
  adminKey: string,
  body: Record<string, unknown>
): Promise<boolean> {
  try {
    console.log(`🚀 TRIGGERING STRIPE NEXT PAGE...`);
    const response = await fetch(`${supabaseUrl}/functions/v1/fetch-stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey,
      },
      body: JSON.stringify(body),
    });
    console.log(`✅ Stripe next page triggered: ${response.status}`);
    return response.ok || response.status === 202;
  } catch (err) {
    console.error(`❌ Failed to trigger Stripe next page:`, err);
    return false;
  }
}

// ============ PROCESS SINGLE PAGE ============
async function processSinglePage(
  supabase: ReturnType<typeof createClient>,
  stripeSecretKey: string,
  syncRunId: string,
  startDate: number | null,
  endDate: number | null,
  cursor: string | null
): Promise<{
  transactions: number;
  clients: number;
  skipped: number;
  paidCount: number;
  failedCount: number;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
}> {
  let paidCount = 0;
  let failedCount = 0;
  let skippedNoEmail = 0;

  try {
    // Build Stripe API URL
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

    const transactions: Array<Record<string, unknown>> = [];
    const clientsMap = new Map<string, Record<string, unknown>>();

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
      let failureCode = pi.last_payment_error?.code || pi.last_payment_error?.decline_code || chargeFailureCode || null;
      let failureMessage = pi.last_payment_error?.message || chargeFailureMessage || null;
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
      const { error: txError, data: txData } = await (supabase.from("transactions") as any)
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
      const { error: clientError, data: clientData } = await (supabase.from("clients") as any)
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

// ============ MAIN HANDLER ============
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

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const adminKey = Deno.env.get("ADMIN_API_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    let fetchAll = false;
    let startDate: number | null = null;
    let endDate: number | null = null;
    let maxPages = 5000;
    
    // Continuation state
    let cursor: string | null = null;
    let syncRunId: string | null = null;
    let pageNumber = 0;
    let totalSynced = 0;
    let totalClients = 0;
    let totalSkipped = 0;
    let totalPaid = 0;
    let totalFailed = 0;
    
    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate) {
        startDate = Math.floor(new Date(body.startDate).getTime() / 1000);
      }
      if (body.endDate) {
        endDate = Math.floor(new Date(body.endDate).getTime() / 1000);
      }
      if (typeof body.maxPages === 'number' && body.maxPages > 0) {
        maxPages = Math.min(body.maxPages, 50000);
      }
      
      // Continuation data
      if (body._continuation) {
        cursor = body._continuation.cursor || null;
        syncRunId = body._continuation.syncRunId || null;
        pageNumber = body._continuation.pageNumber || 0;
        totalSynced = body._continuation.totalSynced || 0;
        totalClients = body._continuation.totalClients || 0;
        totalSkipped = body._continuation.totalSkipped || 0;
        totalPaid = body._continuation.totalPaid || 0;
        totalFailed = body._continuation.totalFailed || 0;
        console.log(`🔄 CONTINUATION: Page ${pageNumber}, cursor: ${cursor?.substring(0, 15)}...`);
      }
    } catch {
      // No body or parse error - use defaults
    }

    // ============ CHECK FOR EXISTING RUNNING/CONTINUING SYNC ============
    if (!syncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      // Check for existing active sync
      const { data: existingRuns } = await supabase
        .from('sync_runs')
        .select('id, status, started_at, checkpoint')
        .eq('source', 'stripe')
        .in('status', ['running', 'continuing'])
        .order('started_at', { ascending: false })
        .limit(1);

      if (existingRuns && existingRuns.length > 0) {
        const existingRun = existingRuns[0];
        
        // Check if stale
        if (existingRun.started_at < staleThreshold) {
          console.log(`⏰ Marking stale Stripe sync ${existingRun.id} as failed`);
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
          console.log(`📍 Resuming existing Stripe sync ${existingRun.id}`);
          const checkpoint = existingRun.checkpoint as Record<string, unknown> || {};
          syncRunId = existingRun.id;
          cursor = (checkpoint.cursor as string) || null;
          pageNumber = (checkpoint.page as number) || 0;
          totalSynced = (checkpoint.totalSynced as number) || 0;
          totalClients = (checkpoint.totalClients as number) || 0;
          totalSkipped = (checkpoint.totalSkipped as number) || 0;
          totalPaid = (checkpoint.totalPaid as number) || 0;
          totalFailed = (checkpoint.totalFailed as number) || 0;
        }
      }
    }

    // Create or reuse sync_run
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'stripe',
          status: 'running',
          metadata: { fetchAll, startDate, endDate, maxPages }
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
      console.log(`📊 NEW STRIPE SYNC RUN: ${syncRunId}`);
    }

    // ============ PROCESS SINGLE PAGE ============
    console.log(`📄 Processing Stripe page ${pageNumber + 1}...`);
    
    const pageResult = await processSinglePage(
      supabase as any,
      stripeSecretKey,
      syncRunId!,
      startDate,
      endDate,
      cursor
    );

    // Update totals
    totalSynced += pageResult.transactions;
    totalClients += pageResult.clients;
    totalSkipped += pageResult.skipped;
    totalPaid += pageResult.paidCount;
    totalFailed += pageResult.failedCount;
    pageNumber++;

    // Handle errors
    if (pageResult.error) {
      console.error(`❌ Stripe Page ${pageNumber} failed:`, pageResult.error);
      
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: pageResult.error,
          total_fetched: totalSynced + totalSkipped,
          total_inserted: totalSynced,
          total_skipped: totalSkipped,
          checkpoint: { cursor, page: pageNumber }
        })
        .eq('id', syncRunId);
      
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: pageResult.error,
          syncRunId,
          page: pageNumber,
          totalSynced 
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`✅ Stripe Page ${pageNumber}: ${pageResult.transactions} tx, ${pageResult.clients} clients`);

    // ============ DECIDE: CONTINUE OR COMPLETE ============
    const needsContinuation = fetchAll && pageResult.hasMore && pageNumber < maxPages;

    if (needsContinuation) {
      // Update checkpoint with heartbeat
      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: totalSynced + totalSkipped,
          total_inserted: totalSynced,
          total_skipped: totalSkipped,
          checkpoint: { 
            cursor: pageResult.nextCursor, 
            page: pageNumber,
            totalSynced,
            totalClients,
            totalSkipped,
            totalPaid,
            totalFailed,
            lastHeartbeat: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      // ============ CRITICAL: TRIGGER NEXT PAGE BEFORE RETURNING ============
      const triggered = await triggerNextPage(supabaseUrl, adminKey, {
        fetchAll,
        startDate: startDate ? new Date(startDate * 1000).toISOString() : undefined,
        endDate: endDate ? new Date(endDate * 1000).toISOString() : undefined,
        maxPages,
        _continuation: {
          cursor: pageResult.nextCursor,
          syncRunId,
          pageNumber,
          totalSynced,
          totalClients,
          totalSkipped,
          totalPaid,
          totalFailed
        }
      });

      if (!triggered) {
        // Failed to trigger - mark as failed
        await supabase
          .from('sync_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Failed to trigger next page continuation',
            total_fetched: totalSynced + totalSkipped,
            total_inserted: totalSynced
          })
          .eq('id', syncRunId);
      }

      const duration = Date.now() - startTime;
      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          syncRunId,
          page: pageNumber,
          totalSynced,
          totalClients,
          hasMore: true,
          duration_ms: duration,
          message: `Stripe Page ${pageNumber} complete. Next page triggered.`
        }),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ SYNC COMPLETE ============
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalSynced + totalSkipped,
        total_inserted: totalSynced,
        total_skipped: totalSkipped,
        metadata: { 
          fetchAll, 
          startDate, 
          endDate, 
          totalPaid, 
          totalFailed, 
          pages: pageNumber 
        }
      })
      .eq('id', syncRunId);

    const duration = Date.now() - startTime;
    console.log(`🎉 STRIPE SYNC COMPLETE: ${totalSynced} transactions, ${totalClients} clients, ${pageNumber} pages in ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId,
        pages: pageNumber,
        synced_transactions: totalSynced,
        totalSynced,
        totalClients,
        totalSkipped,
        totalPaid,
        totalFailed,
        hasMore: false,
        duration_ms: duration
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
