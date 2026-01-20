import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

// Skip invoices linked to subscription statuses that are truly uncollectable
// NOTE: We DO NOT skip 'unpaid' or 'past_due' - these are exactly the delinquent accounts we want to recover!
const SKIP_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired"];
// Skip invoices that are already resolved or uncollectible  
const SKIP_INVOICE_STATUSES = ["paid", "void", "uncollectible"];
const API_DELAY_MS = 150;
const BATCH_SIZE = 15;
const MAX_EXECUTION_MS = 45000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface RecoveryResult {
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
  summary: {
    total_invoices: number;
    processed_invoices: number;
    total_recovered: number;
    total_failed_amount: number;
    total_skipped_amount: number;
    currency: string;
    is_partial: boolean;
    remaining_invoices: number;
    next_starting_after?: string;
  };
}

interface SyncRunRecord {
  id: string;
  source: string;
  status: string;
  started_at: string;
  completed_at?: string;
  metadata?: Record<string, unknown>;
  error_message?: string;
  total_fetched?: number;
  total_inserted?: number;
  total_updated?: number;
  total_skipped?: number;
}

async function processInvoice(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  result: RecoveryResult
): Promise<boolean> {
  const customerEmail = typeof invoice.customer === "object" 
    ? (invoice.customer as Stripe.Customer)?.email 
    : null;
  const customerId = typeof invoice.customer === "string" 
    ? invoice.customer 
    : (invoice.customer as Stripe.Customer)?.id;

  console.log(`\n💳 Processing invoice ${invoice.id} - $${(invoice.amount_due / 100).toFixed(2)}`);

  if (SKIP_INVOICE_STATUSES.includes(invoice.status!)) {
    console.log(`🚫 SKIPPING: Invoice ${invoice.id} is ${invoice.status}`);
    result.skipped.push({
      invoice_id: invoice.id,
      customer_email: customerEmail,
      amount_due: invoice.amount_due,
      currency: invoice.currency,
      reason: `Invoice is ${invoice.status}`,
    });
    result.summary.total_skipped_amount += invoice.amount_due;
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
      result.summary.total_skipped_amount += invoice.amount_due;
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
      result.summary.total_recovered += paidInvoice.amount_paid;
      charged = true;
    }
  } catch (error: unknown) {
    cardsTried++;
    lastError = error instanceof Error ? error.message : "Unknown error";
    console.log(`❌ Default payment failed: ${lastError}`);
  }

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
          result.summary.total_recovered += paidInvoice.amount_paid;
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
    result.summary.total_failed_amount += invoice.amount_due;
  }

  return true;
}

// Fetch recently processed invoice IDs from completed sync runs
async function getRecentlyProcessedInvoices(
  supabaseServiceClient: any,
  excludeHours: number
): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - excludeHours * 60 * 60 * 1000).toISOString();
  
  const { data: recentRuns } = await supabaseServiceClient
    .from("sync_runs")
    .select("metadata")
    .eq("source", "smart_recovery")
    .in("status", ["completed", "partial"])
    .gte("completed_at", cutoff);

  const processedIds = new Set<string>();
  
  if (recentRuns) {
    for (const run of recentRuns) {
      const meta = run.metadata as Record<string, unknown> | null;
      if (meta) {
        // Extract invoice IDs from succeeded, failed, and skipped arrays
        const succeeded = (meta.succeeded as Array<{ invoice_id: string }>) || [];
        const failed = (meta.failed as Array<{ invoice_id: string }>) || [];
        const skipped = (meta.skipped as Array<{ invoice_id: string }>) || [];
        
        for (const item of [...succeeded, ...failed, ...skipped]) {
          if (item.invoice_id) processedIds.add(item.invoice_id);
        }
      }
    }
  }
  
  console.log(`🔍 Found ${processedIds.size} invoices processed in last ${excludeHours}h to exclude`);
  return processedIds;
}

// Background task to process all invoices and save results
async function runRecoveryInBackground(
  stripe: Stripe,
  supabaseServiceClient: any,
  syncRunId: string,
  hours_lookback: number,
  starting_after?: string,
  excludeRecentHours?: number
): Promise<void> {
  const startTime = Date.now();
  
  try {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (hours_lookback * 60 * 60);
    console.log(`🔄 Background processing started for sync run ${syncRunId}`);
    console.log(`📅 Cutoff date: ${new Date(cutoffTimestamp * 1000).toISOString()}`);

    // Get recently processed invoices to exclude (avoid duplicate attempts)
    let excludedInvoices = new Set<string>();
    if (excludeRecentHours && excludeRecentHours > 0) {
      excludedInvoices = await getRecentlyProcessedInvoices(supabaseServiceClient, excludeRecentHours);
    }

    const result: RecoveryResult = {
      succeeded: [],
      failed: [],
      skipped: [],
      summary: {
        total_invoices: 0,
        processed_invoices: 0,
        total_recovered: 0,
        total_failed_amount: 0,
        total_skipped_amount: 0,
        currency: "usd",
        is_partial: false,
        remaining_invoices: 0,
      },
    };

    let currentStartingAfter = starting_after;
    let hasMore = true;
    let totalFetched = 0;
    let totalExcluded = 0;

    while (hasMore) {
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_EXECUTION_MS * 2) { // Give background more time
        console.log(`⏰ Background time limit reached (${elapsed}ms)`);
        result.summary.is_partial = true;
        break;
      }

      const params: Stripe.InvoiceListParams = {
        status: "open",
        limit: BATCH_SIZE,
        created: { gte: cutoffTimestamp },
        expand: ["data.subscription", "data.customer"],
      };
      if (currentStartingAfter) params.starting_after = currentStartingAfter;

      await sleep(API_DELAY_MS);
      const response = await stripe.invoices.list(params);
      const invoices = response.data;
      hasMore = response.has_more;
      totalFetched += invoices.length;

      console.log(`📄 Batch: ${invoices.length} invoices (total: ${totalFetched}, hasMore: ${hasMore})`);

      for (const invoice of invoices) {
        currentStartingAfter = invoice.id;
        
        // Skip if already processed recently
        if (excludedInvoices.has(invoice.id)) {
          totalExcluded++;
          console.log(`⏭️ Skipping ${invoice.id} - already processed recently`);
          continue;
        }
        
        await processInvoice(stripe, invoice, result);
        result.summary.processed_invoices++;

        // Update progress after EACH invoice for real-time UI feedback
        await supabaseServiceClient
          .from("sync_runs")
          .update({
            checkpoint: {
              recovered_amount: result.summary.total_recovered / 100,
              failed_amount: result.summary.total_failed_amount / 100,
              skipped_amount: result.summary.total_skipped_amount / 100,
              processed: result.summary.processed_invoices,
              succeeded_count: result.succeeded.length,
              failed_count: result.failed.length,
              skipped_count: result.skipped.length,
              last_invoice: currentStartingAfter,
            },
            total_fetched: totalFetched,
            total_inserted: result.succeeded.length,
            total_updated: result.failed.length,
            total_skipped: result.skipped.length,
          })
          .eq("id", syncRunId);
      }

      result.summary.total_invoices = totalFetched;
    }

    // Complete the sync run
    const elapsed = Date.now() - startTime;
    console.log(`\n🏁 Background Recovery Complete in ${elapsed}ms!`);
    console.log(`📊 Processed: ${result.summary.processed_invoices}/${totalFetched} (${totalExcluded} excluded)`);
    console.log(`✅ Recovered: $${(result.summary.total_recovered / 100).toFixed(2)}`);
    console.log(`❌ Failed: $${(result.summary.total_failed_amount / 100).toFixed(2)}`);
    console.log(`🚫 Skipped: $${(result.summary.total_skipped_amount / 100).toFixed(2)}`);

    await supabaseServiceClient
      .from("sync_runs")
      .update({
        status: result.summary.is_partial ? "partial" : "completed",
        completed_at: new Date().toISOString(),
        metadata: {
          recovered_amount: result.summary.total_recovered / 100,
          failed_amount: result.summary.total_failed_amount / 100,
          skipped_amount: result.summary.total_skipped_amount / 100,
          succeeded_count: result.succeeded.length,
          failed_count: result.failed.length,
          skipped_count: result.skipped.length,
          excluded_count: totalExcluded,
          exclude_recent_hours: excludeRecentHours || 0,
          execution_time_ms: elapsed,
          succeeded: result.succeeded,
          failed: result.failed,
          skipped: result.skipped,
        },
        total_fetched: totalFetched,
        total_inserted: result.succeeded.length,
        total_updated: 0,
        total_skipped: result.skipped.length + totalExcluded,
      })
      .eq("id", syncRunId);

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ Background recovery failed:`, errorMessage);
    
    await supabaseServiceClient
      .from("sync_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: errorMessage,
      })
      .eq("id", syncRunId);
  }
}

// Handle shutdown gracefully
addEventListener('beforeunload', (ev: Event) => {
  const detail = (ev as CustomEvent).detail;
  console.log('🛑 Function shutdown due to:', detail?.reason || 'unknown');
});

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Quick check for Authorization header presence
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse body FIRST before any async operations
    const body = await req.json();
    const { hours_lookback = 24, starting_after, background = false, exclude_recent_hours = 0 } = body;
    
    const validHours = [24, 168, 360, 720, 1440];
    if (!validHours.includes(hours_lookback)) {
      return new Response(
        JSON.stringify({ error: `Invalid hours_lookback. Valid values: ${validHours.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // BACKGROUND MODE: Return IMMEDIATELY, do ALL work in background
    if (background) {
      const tempId = crypto.randomUUID();
      console.log(`🚀 BACKGROUND mode - returning immediately with ID: ${tempId}`);

      // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
      EdgeRuntime.waitUntil((async () => {
        try {
          // All slow operations happen HERE in background
          const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } }
          );

          const { data: { user }, error: userError } = await supabase.auth.getUser();
          if (userError || !user) {
            console.error("❌ Background auth failed:", userError?.message);
            return;
          }

          console.log("✅ Background auth OK:", user.email);

          const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
          const supabaseServiceClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
          );

          // Create sync run record
          const { data: syncRun, error: syncError } = await supabaseServiceClient
            .from("sync_runs")
            .insert({
              id: tempId,
              source: "smart_recovery",
              status: "running",
              started_at: new Date().toISOString(),
              metadata: {
                hours_lookback,
                starting_after: starting_after || null,
                initiated_by: user.email,
                exclude_recent_hours: exclude_recent_hours || 0,
              },
            })
            .select()
            .single();

          if (syncError || !syncRun) {
            console.error("❌ Failed to create sync run:", syncError?.message);
            return;
          }

          console.log(`📝 Created sync run: ${syncRun.id}`);
          await runRecoveryInBackground(stripe, supabaseServiceClient, syncRun.id, hours_lookback, starting_after, exclude_recent_hours);
        } catch (err) {
          console.error("❌ Background processing error:", err);
        }
      })());

      // Return IMMEDIATELY - no await, no DB calls before this
      return new Response(
        JSON.stringify({ 
          message: "Smart Recovery started in background",
          sync_run_id: tempId,
          status: "running",
          hours_lookback,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // FOREGROUND MODE: Full authentication required
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", user.email);

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const supabaseServiceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // FOREGROUND MODE: Original synchronous processing
    console.log(`🔍 Smart Recovery starting - Looking back ${hours_lookback} hours`);
    if (starting_after) {
      console.log(`📍 Resuming from invoice: ${starting_after}`);
    }

    const startTime = Date.now();
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (hours_lookback * 60 * 60);
    console.log(`📅 Cutoff date: ${new Date(cutoffTimestamp * 1000).toISOString()}`);

    const params: Stripe.InvoiceListParams = {
      status: "open",
      limit: BATCH_SIZE,
      created: { gte: cutoffTimestamp },
      expand: ["data.subscription", "data.customer"],
    };
    if (starting_after) params.starting_after = starting_after;

    await sleep(API_DELAY_MS);
    const response = await stripe.invoices.list(params);
    const invoices = response.data;
    const hasMore = response.has_more;

    console.log(`📄 Fetched ${invoices.length} open invoices (hasMore: ${hasMore})`);

    const result: RecoveryResult = {
      succeeded: [],
      failed: [],
      skipped: [],
      summary: {
        total_invoices: invoices.length,
        processed_invoices: 0,
        total_recovered: 0,
        total_failed_amount: 0,
        total_skipped_amount: 0,
        currency: "usd",
        is_partial: false,
        remaining_invoices: 0,
      },
    };

    let lastProcessedId: string | undefined;

    for (const invoice of invoices) {
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_EXECUTION_MS) {
        console.log(`⏰ Time limit approaching (${elapsed}ms), returning partial results`);
        result.summary.is_partial = true;
        result.summary.remaining_invoices = invoices.length - result.summary.processed_invoices;
        if (lastProcessedId) {
          result.summary.next_starting_after = lastProcessedId;
        }
        break;
      }

      await processInvoice(stripe, invoice, result);
      result.summary.processed_invoices++;
      lastProcessedId = invoice.id;
    }

    if (hasMore && !result.summary.is_partial) {
      result.summary.is_partial = true;
      result.summary.remaining_invoices = -1;
      result.summary.next_starting_after = lastProcessedId;
    }

    const elapsed = Date.now() - startTime;
    console.log(`\n🏁 Smart Recovery Complete in ${elapsed}ms!`);
    console.log(`📊 Processed: ${result.summary.processed_invoices}/${invoices.length}`);
    console.log(`✅ Recovered: $${(result.summary.total_recovered / 100).toFixed(2)}`);
    console.log(`❌ Failed: $${(result.summary.total_failed_amount / 100).toFixed(2)}`);
    console.log(`🚫 Skipped: $${(result.summary.total_skipped_amount / 100).toFixed(2)}`);
    if (result.summary.is_partial) {
      console.log(`⏳ Partial result - more invoices pending`);
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const origin = req.headers.get("origin");
    console.error("❌ Fatal error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
