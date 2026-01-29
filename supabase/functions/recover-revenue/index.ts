import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Skip invoices linked to subscription statuses that are truly uncollectable
const SKIP_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired"];
// Skip invoices that are already resolved or uncollectible  
const SKIP_INVOICE_STATUSES = ["paid", "void", "uncollectible"];
const API_DELAY_MS = 80;
const BATCH_SIZE = 3; // Procesar 3 facturas por invocación
const MAX_CHUNKS_PER_CALL = 1; // Procesar 1 batch y auto-continuar

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ProcessResult {
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
  recovered_cents: number;
  failed_cents: number;
  skipped_cents: number;
}

// Track recent attempts to avoid spamming Stripe
interface AttemptRecord {
  last_attempt: string;
  attempt_count: number;
}

async function getRecentAttempts(supabaseClient: any, syncRunId: string): Promise<Map<string, AttemptRecord>> {
  const { data } = await supabaseClient
    .from("sync_runs")
    .select("metadata")
    .eq("id", syncRunId)
    .single();
  
  const attempts = new Map<string, AttemptRecord>();
  if (data?.metadata?.attempt_history) {
    const history = data.metadata.attempt_history as Record<string, AttemptRecord>;
    for (const [invoiceId, record] of Object.entries(history)) {
      attempts.set(invoiceId, record);
    }
  }
  return attempts;
}

function shouldSkipDueToRecentAttempt(attemptRecord: AttemptRecord | undefined): { skip: boolean; reason?: string } {
  if (!attemptRecord) return { skip: false };
  
  const lastAttempt = new Date(attemptRecord.last_attempt);
  const hoursSince = (Date.now() - lastAttempt.getTime()) / (1000 * 60 * 60);
  
  // Skip if attempted in last 24h
  if (hoursSince < 24) {
    return { skip: true, reason: `Already attempted ${hoursSince.toFixed(1)}h ago` };
  }
  
  // Skip if 3+ attempts in last 7 days
  if (attemptRecord.attempt_count >= 3 && hoursSince < 168) {
    return { skip: true, reason: `Max attempts (${attemptRecord.attempt_count}) reached this week` };
  }
  
  return { skip: false };
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);

  try {
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
      cursor,
      sync_run_id,
      _continuation = false, // Flag for auto-continuation
    } = body;
    
    console.log(`[${requestId}] 🚀 recover-revenue: hours=${hours_lookback}, continuation=${_continuation}, cursor=${cursor?.slice(0, 20) || 'none'}`);

    const validHours = [24, 168, 360, 720, 1440];
    if (!validHours.includes(hours_lookback)) {
      return new Response(
        JSON.stringify({ ok: false, error: `Invalid hours_lookback. Valid: ${validHours.join(", ")}` }),
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const supabaseService = createClient(supabaseUrl, serviceRoleKey);
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

    // ============= KILL SWITCH: Check if auto-dunning is enabled =============
    const { data: autoDunningConfig } = await supabaseService
      .from('system_settings')
      .select('value')
      .eq('key', 'auto_dunning_enabled')
      .single();

    const autoDunningEnabled = autoDunningConfig?.value !== 'false'; // Default: enabled
    
    if (!autoDunningEnabled) {
      console.log(`[${requestId}] ⏸️ Auto-dunning disabled globally, skipping revenue recovery`);
      return new Response(
        JSON.stringify({ 
          ok: true, 
          success: true, 
          status: 'skipped', 
          skipped: true, 
          reason: 'Feature disabled: auto_dunning_enabled is OFF' 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ===========================================================================

    // For continuation calls, skip auth check (we use service role)
    if (!_continuation) {
      const supabaseUser = createClient(
        supabaseUrl,
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
      console.log(`[${requestId}] ✅ User: ${user.email}`);
    }

    let syncRunId = sync_run_id;
    let currentCursor = cursor;

    // Create or resume sync run
    if (!syncRunId) {
      // Check for existing running sync
      const { data: existingRun } = await supabaseService
        .from("sync_runs")
        .select("*")
        .eq("source", "smart_recovery")
        .eq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1);
      
      if (existingRun?.[0]) {
        const run = existingRun[0];
        const startedAt = new Date(run.started_at).getTime();
        const checkpoint = run.checkpoint as Record<string, unknown> | null;
        const lastActivity = checkpoint?.lastActivity ? new Date(checkpoint.lastActivity as string).getTime() : startedAt;
        const staleMinutes = (Date.now() - lastActivity) / (1000 * 60);
        
        if (staleMinutes > 5) {
          console.log(`[${requestId}] ⚠️ Stale run ${run.id} (${staleMinutes.toFixed(1)}m), marking failed`);
          await supabaseService
            .from("sync_runs")
            .update({ status: "failed", completed_at: new Date().toISOString(), error_message: "Timeout - no activity" })
            .eq("id", run.id);
        } else {
          syncRunId = run.id;
          currentCursor = checkpoint?.last_cursor as string || undefined;
          console.log(`[${requestId}] 📋 Resuming ${syncRunId}`);
        }
      }
      
      if (!syncRunId) {
        const newId = crypto.randomUUID();
        await supabaseService.from("sync_runs").insert({
          id: newId,
          source: "smart_recovery",
          status: "running",
          started_at: new Date().toISOString(),
          metadata: { hours_lookback, attempt_history: {} },
          checkpoint: {
            last_cursor: null,
            recovered_amount: 0,
            failed_amount: 0,
            skipped_amount: 0,
            processed: 0,
            succeeded_count: 0,
            failed_count: 0,
            skipped_count: 0,
            lastActivity: new Date().toISOString(),
          },
        });
        syncRunId = newId;
        console.log(`[${requestId}] 📝 Created run: ${syncRunId}`);
      }
    }

    // Get attempt history to avoid re-trying recently failed invoices
    const attemptHistory = await getRecentAttempts(supabaseService, syncRunId);

    // Fetch invoices from Stripe
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (hours_lookback * 60 * 60);

    const params: Stripe.InvoiceListParams = {
      status: "open",
      limit: BATCH_SIZE,
      created: { gte: cutoffTimestamp },
      expand: ["data.subscription", "data.customer"],
    };
    if (currentCursor) params.starting_after = currentCursor;

    await sleep(API_DELAY_MS);
    const response = await stripe.invoices.list(params);
    const allInvoices = response.data;
    const stripeHasMore = response.has_more;

    console.log(`[${requestId}] 📄 Fetched ${allInvoices.length} invoices, hasMore: ${stripeHasMore}`);

    // No invoices in range
    if (allInvoices.length === 0 && !currentCursor) {
      console.log(`[${requestId}] 📭 No invoices in range`);
      
      await supabaseService.from("sync_runs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        checkpoint: {
          recovered_amount: 0, failed_amount: 0, skipped_amount: 0,
          processed: 0, succeeded_count: 0, failed_count: 0, skipped_count: 0,
          lastActivity: new Date().toISOString(),
        },
      }).eq("id", syncRunId);

      return new Response(
        JSON.stringify({
          ok: true,
          status: "completed",
          syncRunId,
          message: `No hay facturas abiertas en las últimas ${hours_lookback / 24} días`,
          hasMore: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Process invoices with skip checks
    const result: ProcessResult = {
      succeeded: [],
      failed: [],
      skipped: [],
      recovered_cents: 0,
      failed_cents: 0,
      skipped_cents: 0,
    };

    const updatedAttemptHistory: Record<string, AttemptRecord> = {};
    let lastProcessedId: string | undefined;

    for (const invoice of allInvoices) {
      // Check if recently attempted
      const attemptCheck = shouldSkipDueToRecentAttempt(attemptHistory.get(invoice.id));
      if (attemptCheck.skip) {
        console.log(`[${requestId}] ⏭️ Skipping ${invoice.id}: ${attemptCheck.reason}`);
        result.skipped.push({
          invoice_id: invoice.id,
          customer_email: typeof invoice.customer === "object" ? (invoice.customer as Stripe.Customer)?.email : null,
          amount_due: invoice.amount_due,
          currency: invoice.currency,
          reason: attemptCheck.reason!,
        });
        result.skipped_cents += invoice.amount_due;
        lastProcessedId = invoice.id;
        continue;
      }

      await processInvoice(stripe, invoice, result);
      lastProcessedId = invoice.id;

      // Track this attempt
      const prev = attemptHistory.get(invoice.id);
      updatedAttemptHistory[invoice.id] = {
        last_attempt: new Date().toISOString(),
        attempt_count: (prev?.attempt_count || 0) + 1,
      };
    }

    const hasMore = stripeHasMore;
    const nextCursor = lastProcessedId || (allInvoices.length > 0 ? allInvoices[allInvoices.length - 1].id : undefined);

    // Update sync run with progress
    const { data: currentRun } = await supabaseService
      .from("sync_runs")
      .select("metadata, checkpoint")
      .eq("id", syncRunId)
      .single();

    const existingMeta = (currentRun?.metadata as Record<string, unknown>) || {};
    const existingCheckpoint = (currentRun?.checkpoint as Record<string, unknown>) || {};
    
    const mergedAttemptHistory = {
      ...((existingMeta.attempt_history as Record<string, AttemptRecord>) || {}),
      ...updatedAttemptHistory,
    };

    const prevRecovered = (existingCheckpoint.recovered_amount as number) || 0;
    const prevFailed = (existingCheckpoint.failed_amount as number) || 0;
    const prevSkipped = (existingCheckpoint.skipped_amount as number) || 0;
    const prevProcessed = (existingCheckpoint.processed as number) || 0;
    const prevSucceededCount = (existingCheckpoint.succeeded_count as number) || 0;
    const prevFailedCount = (existingCheckpoint.failed_count as number) || 0;
    const prevSkippedCount = (existingCheckpoint.skipped_count as number) || 0;

    const newCheckpoint = {
      last_cursor: nextCursor,
      recovered_amount: prevRecovered + result.recovered_cents / 100,
      failed_amount: prevFailed + result.failed_cents / 100,
      skipped_amount: prevSkipped + result.skipped_cents / 100,
      processed: prevProcessed + allInvoices.length,
      succeeded_count: prevSucceededCount + result.succeeded.length,
      failed_count: prevFailedCount + result.failed.length,
      skipped_count: prevSkippedCount + result.skipped.length,
      lastActivity: new Date().toISOString(),
    };

    const newStatus = hasMore ? "running" : "completed";

    await supabaseService.from("sync_runs").update({
      status: newStatus,
      completed_at: newStatus === "completed" ? new Date().toISOString() : null,
      metadata: { ...existingMeta, attempt_history: mergedAttemptHistory },
      checkpoint: newCheckpoint,
      total_fetched: (existingCheckpoint.processed as number || 0) + allInvoices.length,
      total_inserted: newCheckpoint.succeeded_count,
      total_skipped: newCheckpoint.skipped_count,
    }).eq("id", syncRunId);

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] 🏁 Batch done in ${duration}ms - hasMore: ${hasMore}`);
    console.log(`[${requestId}] ✅ Recovered: $${(result.recovered_cents / 100).toFixed(2)}`);

    // Auto-continuation with background task
    if (hasMore && nextCursor) {
      console.log(`[${requestId}] 🔄 Auto-continuing with cursor ${nextCursor.slice(0, 20)}...`);
      
      // Use globalThis.EdgeRuntime for Deno/Supabase compatibility
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) {
        runtime.waitUntil((async () => {
          await sleep(1500); // 1.5s delay between batches
          
          try {
            await fetch(`${supabaseUrl}/functions/v1/recover-revenue`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${serviceRoleKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                hours_lookback,
                cursor: nextCursor,
                sync_run_id: syncRunId,
                _continuation: true,
              }),
            });
          } catch (err) {
            console.error(`[${requestId}] ❌ Auto-continuation failed:`, err);
          }
        })());
      } else {
        // Fallback: direct fetch without waitUntil
        console.log(`[${requestId}] ⚠️ No EdgeRuntime.waitUntil, using direct fetch`);
        fetch(`${supabaseUrl}/functions/v1/recover-revenue`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            hours_lookback,
            cursor: nextCursor,
            sync_run_id: syncRunId,
            _continuation: true,
          }),
        }).catch(err => console.error(`[${requestId}] ❌ Fallback continuation failed:`, err));
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: newStatus,
        syncRunId,
        processed: allInvoices.length,
        hasMore,
        duration_ms: duration,
        checkpoint: newCheckpoint,
        batch: {
          succeeded: result.succeeded.length,
          failed: result.failed.length,
          skipped: result.skipped.length,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${requestId}] ❌ Fatal:`, errorMessage);
    
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage, duration_ms: Date.now() - startTime }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
