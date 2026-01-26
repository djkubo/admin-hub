import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/.*\.lovable\.app$/,
  /^https:\/\/.*\.lovableproject\.com$/,
  /^https:\/\/lovable\.dev$/,
  /^http:\/\/localhost:\d+$/,
];

function getCorsHeaders(origin: string | null) {
  const isAllowed = origin && ALLOWED_ORIGIN_PATTERNS.some(pattern => pattern.test(origin));
  const allowedOrigin = isAllowed ? origin : "https://lovable.dev";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// Skip invoices linked to subscription statuses that are truly uncollectable
const SKIP_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired"];
// Skip invoices that are already resolved or uncollectible  
const SKIP_INVOICE_STATUSES = ["paid", "void", "uncollectible"];
const API_DELAY_MS = 150;
const BATCH_SIZE = 10; // Process 10 invoices per invocation for reliability
const MAX_INVOICES_PER_CALL = 20; // Maximum invoices to process in a single call

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============= Standard Response Contract =============
interface StandardRecoveryResponse {
  ok: boolean;
  status: string;
  syncRunId: string;
  processed: number;
  hasMore: boolean;
  nextCursor?: string;
  duration_ms: number;
  recovered_amount: number;
  failed_amount: number;
  skipped_amount: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  error?: string;
  // Detailed results for this batch
  succeeded: Array<{
    invoice_id: string;
    customer_email: string | null;
    amount_recovered: number;
    currency: string;
    payment_method_used: string;
  }>;
  failed: Array<{
    invoice_id: string;
    customer_email: string | null;
    amount_due: number;
    currency: string;
    error: string;
    cards_tried: number;
  }>;
  skipped: Array<{
    invoice_id: string;
    customer_email: string | null;
    amount_due: number;
    currency: string;
    reason: string;
    subscription_status?: string;
  }>;
}

interface ProcessResult {
  succeeded: StandardRecoveryResponse['succeeded'];
  failed: StandardRecoveryResponse['failed'];
  skipped: StandardRecoveryResponse['skipped'];
  recovered_cents: number;
  failed_cents: number;
  skipped_cents: number;
}

async function processInvoice(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  result: ProcessResult
): Promise<boolean> {
  const customerEmail = typeof invoice.customer === "object" 
    ? (invoice.customer as Stripe.Customer)?.email 
    : null;
  const customerId = typeof invoice.customer === "string" 
    ? invoice.customer 
    : (invoice.customer as Stripe.Customer)?.id;

  console.log(`💳 Processing invoice ${invoice.id} - $${(invoice.amount_due / 100).toFixed(2)}`);

  if (SKIP_INVOICE_STATUSES.includes(invoice.status!)) {
    console.log(`🚫 SKIPPING: Invoice ${invoice.id} is ${invoice.status}`);
    result.skipped.push({
      invoice_id: invoice.id,
      customer_email: customerEmail,
      amount_due: invoice.amount_due,
      currency: invoice.currency,
      reason: `Invoice is ${invoice.status}`,
    });
    result.skipped_cents += invoice.amount_due;
    return true;
  }

  if (invoice.subscription) {
    const subscription = invoice.subscription as Stripe.Subscription;
    
    if (SKIP_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
      console.log(`🚫 SKIPPING: Subscription ${subscription.id} is ${subscription.status}`);
      result.skipped.push({
        invoice_id: invoice.id,
        customer_email: customerEmail,
        amount_due: invoice.amount_due,
        currency: invoice.currency,
        reason: `Subscription is ${subscription.status}`,
        subscription_status: subscription.status,
      });
      result.skipped_cents += invoice.amount_due;
      return true;
    }
    console.log(`✅ Subscription status: ${subscription.status} - proceeding`);
  }

  await sleep(API_DELAY_MS);
  let paymentMethods: Stripe.PaymentMethod[] = [];
  try {
    const pmList = await stripe.paymentMethods.list({
      customer: customerId!,
      type: "card",
    });
    paymentMethods = pmList.data;
    console.log(`💳 Customer has ${paymentMethods.length} payment method(s)`);
  } catch (pmError) {
    console.error(`❌ Error fetching payment methods:`, pmError);
  }

  let charged = false;
  let lastError = "";
  let cardsTried = 0;

  // Try default payment method first
  try {
    await sleep(API_DELAY_MS);
    console.log(`💰 Attempting to pay with default payment method...`);
    const paidInvoice = await stripe.invoices.pay(invoice.id);
    
    if (paidInvoice.status === "paid") {
      console.log(`✅ SUCCESS with default payment method!`);
      result.succeeded.push({
        invoice_id: invoice.id,
        customer_email: customerEmail,
        amount_recovered: paidInvoice.amount_paid,
        currency: paidInvoice.currency,
        payment_method_used: "default",
      });
      result.recovered_cents += paidInvoice.amount_paid;
      charged = true;
    }
  } catch (error: unknown) {
    cardsTried++;
    lastError = error instanceof Error ? error.message : "Unknown error";
    console.log(`❌ Default payment failed: ${lastError}`);
  }

  // Try other payment methods
  if (!charged && paymentMethods.length > 0) {
    const methodsToTry = paymentMethods.slice(0, 2);
    
    for (const pm of methodsToTry) {
      if (charged) break;
      
      try {
        await sleep(API_DELAY_MS);
        console.log(`💳 Trying payment method ${pm.id} (${pm.card?.brand} ****${pm.card?.last4})...`);
        
        await stripe.invoices.update(invoice.id, {
          default_payment_method: pm.id,
        });
        
        await sleep(API_DELAY_MS);
        const paidInvoice = await stripe.invoices.pay(invoice.id);
        
        if (paidInvoice.status === "paid") {
          console.log(`✅ SUCCESS with ${pm.card?.brand} ****${pm.card?.last4}!`);
          result.succeeded.push({
            invoice_id: invoice.id,
            customer_email: customerEmail,
            amount_recovered: paidInvoice.amount_paid,
            currency: paidInvoice.currency,
            payment_method_used: `${pm.card?.brand} ****${pm.card?.last4}`,
          });
          result.recovered_cents += paidInvoice.amount_paid;
          charged = true;
        }
      } catch (error: unknown) {
        cardsTried++;
        lastError = error instanceof Error ? error.message : "Unknown error";
        console.log(`❌ Card ${pm.card?.last4} failed: ${lastError}`);
      }
    }
  }

  if (!charged) {
    console.log(`❌ FAILED: All ${cardsTried} payment attempts failed`);
    result.failed.push({
      invoice_id: invoice.id,
      customer_email: customerEmail,
      amount_due: invoice.amount_due,
      currency: invoice.currency,
      error: lastError,
      cards_tried: cardsTried,
    });
    result.failed_cents += invoice.amount_due;
  }

  return true;
}

// Check if there's already an active recovery run
async function getActiveRecoveryRun(supabaseClient: any): Promise<any | null> {
  const { data } = await supabaseClient
    .from("sync_runs")
    .select("*")
    .eq("source", "smart_recovery")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1);
  
  return data?.[0] || null;
}

// Get invoice IDs already processed in this run
async function getProcessedInvoicesFromRun(supabaseClient: any, syncRunId: string): Promise<Set<string>> {
  const { data: syncRun } = await supabaseClient
    .from("sync_runs")
    .select("metadata")
    .eq("id", syncRunId)
    .single();
  
  const processedIds = new Set<string>();
  
  if (syncRun?.metadata) {
    const meta = syncRun.metadata as Record<string, unknown>;
    const succeeded = (meta.succeeded_ids as string[]) || [];
    const failed = (meta.failed_ids as string[]) || [];
    const skipped = (meta.skipped_ids as string[]) || [];
    
    for (const id of [...succeeded, ...failed, ...skipped]) {
      processedIds.add(id);
    }
  }
  
  return processedIds;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // Quick auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { 
      hours_lookback = 24, 
      cursor, // starting_after for pagination
      sync_run_id, // Existing run to continue
      exclude_recent_hours = 0,
      force_new = false, // Force create new run even if one exists
    } = body;
    
    const validHours = [24, 168, 360, 720, 1440];
    if (!validHours.includes(hours_lookback)) {
      return new Response(
        JSON.stringify({ ok: false, error: `Invalid hours_lookback. Valid values: ${validHours.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Authenticate user
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ ok: false, error: "Authentication failed" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`✅ User authenticated: ${user.email}`);

    const supabaseService = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

    let syncRunId = sync_run_id;
    let isNewRun = false;
    let currentCursor = cursor;

    // Check for existing active run OR create new one
    if (!syncRunId) {
      const activeRun = await getActiveRecoveryRun(supabaseService);
      
      if (activeRun && !force_new) {
        // Check if it's stale (> 10 minutes old without progress)
        const startedAt = new Date(activeRun.started_at).getTime();
        const isStale = Date.now() - startedAt > 10 * 60 * 1000;
        
        if (isStale) {
          console.log(`⚠️ Found stale active run ${activeRun.id}, marking as failed`);
          await supabaseService
            .from("sync_runs")
            .update({ status: "failed", completed_at: new Date().toISOString(), error_message: "Timed out" })
            .eq("id", activeRun.id);
        } else {
          // Resume existing run
          syncRunId = activeRun.id;
          const checkpoint = activeRun.checkpoint as Record<string, unknown> | null;
          currentCursor = checkpoint?.last_cursor as string || undefined;
          console.log(`📋 Resuming existing run ${syncRunId} from cursor ${currentCursor}`);
        }
      }
      
      if (!syncRunId) {
        // Create new run
        const newId = crypto.randomUUID();
        const { error: insertError } = await supabaseService
          .from("sync_runs")
          .insert({
            id: newId,
            source: "smart_recovery",
            status: "running",
            started_at: new Date().toISOString(),
            metadata: {
              hours_lookback,
              initiated_by: user.email,
              exclude_recent_hours,
              succeeded_ids: [],
              failed_ids: [],
              skipped_ids: [],
            },
            checkpoint: {
              last_cursor: null,
              recovered_amount: 0,
              failed_amount: 0,
              skipped_amount: 0,
              processed: 0,
            },
          });
        
        if (insertError) {
          console.error("❌ Failed to create sync run:", insertError);
          return new Response(
            JSON.stringify({ ok: false, error: "Failed to create sync run" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        syncRunId = newId;
        isNewRun = true;
        console.log(`📝 Created new sync run: ${syncRunId}`);
      }
    }

    // Get already processed invoices from this run
    const processedInRun = await getProcessedInvoicesFromRun(supabaseService, syncRunId);
    console.log(`📋 Already processed in this run: ${processedInRun.size} invoices`);

    // Fetch invoices from Stripe
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (hours_lookback * 60 * 60);
    console.log(`📅 Cutoff: ${new Date(cutoffTimestamp * 1000).toISOString()}`);

    const params: Stripe.InvoiceListParams = {
      status: "open",
      limit: MAX_INVOICES_PER_CALL,
      created: { gte: cutoffTimestamp },
      expand: ["data.subscription", "data.customer"],
    };
    if (currentCursor) params.starting_after = currentCursor;

    await sleep(API_DELAY_MS);
    const response = await stripe.invoices.list(params);
    const allInvoices = response.data;
    const stripeHasMore = response.has_more;

    // Filter out already processed
    const invoicesToProcess = allInvoices.filter((inv: Stripe.Invoice) => !processedInRun.has(inv.id));
    console.log(`📄 Fetched ${allInvoices.length} invoices, ${invoicesToProcess.length} new to process`);

    // Process invoices
    const result: ProcessResult = {
      succeeded: [],
      failed: [],
      skipped: [],
      recovered_cents: 0,
      failed_cents: 0,
      skipped_cents: 0,
    };

    let lastProcessedId: string | undefined;

    for (const invoice of invoicesToProcess) {
      await processInvoice(stripe, invoice, result);
      lastProcessedId = invoice.id;
    }

    // Determine if there's more to process
    const hasMore = stripeHasMore || invoicesToProcess.length === 0 && allInvoices.length > 0;
    const nextCursor = lastProcessedId || (allInvoices.length > 0 ? allInvoices[allInvoices.length - 1].id : undefined);

    // Update sync run with progress
    const { data: currentRun } = await supabaseService
      .from("sync_runs")
      .select("metadata, checkpoint, total_fetched, total_inserted, total_skipped")
      .eq("id", syncRunId)
      .single();

    const existingMeta = (currentRun?.metadata as Record<string, unknown>) || {};
    const existingCheckpoint = (currentRun?.checkpoint as Record<string, unknown>) || {};
    
    const updatedMeta = {
      ...existingMeta,
      succeeded_ids: [...((existingMeta.succeeded_ids as string[]) || []), ...result.succeeded.map(s => s.invoice_id)],
      failed_ids: [...((existingMeta.failed_ids as string[]) || []), ...result.failed.map(f => f.invoice_id)],
      skipped_ids: [...((existingMeta.skipped_ids as string[]) || []), ...result.skipped.map(s => s.invoice_id)],
    };

    const prevRecovered = (existingCheckpoint.recovered_amount as number) || 0;
    const prevFailed = (existingCheckpoint.failed_amount as number) || 0;
    const prevSkipped = (existingCheckpoint.skipped_amount as number) || 0;
    const prevProcessed = (existingCheckpoint.processed as number) || 0;

    const updatedCheckpoint = {
      last_cursor: nextCursor,
      recovered_amount: prevRecovered + result.recovered_cents / 100,
      failed_amount: prevFailed + result.failed_cents / 100,
      skipped_amount: prevSkipped + result.skipped_cents / 100,
      processed: prevProcessed + invoicesToProcess.length,
      succeeded_count: (updatedMeta.succeeded_ids as string[]).length,
      failed_count: (updatedMeta.failed_ids as string[]).length,
      skipped_count: (updatedMeta.skipped_ids as string[]).length,
    };

    const newStatus = hasMore ? "running" : "completed";

    await supabaseService
      .from("sync_runs")
      .update({
        status: newStatus,
        completed_at: newStatus === "completed" ? new Date().toISOString() : null,
        metadata: updatedMeta,
        checkpoint: updatedCheckpoint,
        total_fetched: (currentRun?.total_fetched || 0) + allInvoices.length,
        total_inserted: updatedCheckpoint.succeeded_count,
        total_skipped: updatedCheckpoint.skipped_count,
      })
      .eq("id", syncRunId);

    const duration = Date.now() - startTime;
    console.log(`\n🏁 Batch complete in ${duration}ms - hasMore: ${hasMore}`);
    console.log(`✅ Recovered: $${(result.recovered_cents / 100).toFixed(2)}`);
    console.log(`❌ Failed: $${(result.failed_cents / 100).toFixed(2)}`);

    const responseBody: StandardRecoveryResponse = {
      ok: true,
      status: newStatus,
      syncRunId,
      processed: invoicesToProcess.length,
      hasMore,
      nextCursor: hasMore ? nextCursor : undefined,
      duration_ms: duration,
      recovered_amount: updatedCheckpoint.recovered_amount,
      failed_amount: updatedCheckpoint.failed_amount,
      skipped_amount: updatedCheckpoint.skipped_amount,
      succeeded_count: updatedCheckpoint.succeeded_count,
      failed_count: updatedCheckpoint.failed_count,
      skipped_count: updatedCheckpoint.skipped_count,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
    };

    return new Response(
      JSON.stringify(responseBody),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Fatal error:", errorMessage);
    
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: errorMessage,
        duration_ms: Date.now() - startTime,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
