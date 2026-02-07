// deno-lint-ignore-file no-explicit-any
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Supabase Edge Functions exposes EdgeRuntime at runtime, but TypeScript doesn't know about it.
declare const EdgeRuntime:
  | undefined
  | {
      waitUntil?: (promise: Promise<unknown>) => void;
    };

// SECURITY: JWT-based admin verification using getUser()
async function verifyAdmin(req: Request): Promise<{ valid: boolean; error?: string }> {
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

  return { valid: true };
}

// ============ PLAN CLASSIFICATION BY AMOUNT/INTERVAL ============
// This replaces fragile string-based matching with amount-based logic
function classifyPlan(amount: number, interval: string, productName: string | null, nickname: string | null): string {
  // Amount is in cents
  const amountUSD = amount / 100;
  
  // Annual plans (typically $150-$250/year range)
  if (interval === 'year') {
    if (amountUSD >= 180 && amountUSD <= 220) {
      return 'Plan Anual ~$195';
    }
    if (amountUSD >= 350 && amountUSD <= 450) {
      return 'Plan Anual Premium ~$400';
    }
    // Generic annual
    return `Plan Anual $${Math.round(amountUSD)}`;
  }
  
  // Monthly plans
  if (interval === 'month') {
    if (amountUSD >= 30 && amountUSD <= 40) {
      return 'Plan Mensual ~$35';
    }
    if (amountUSD >= 45 && amountUSD <= 55) {
      return 'Plan Mensual ~$50';
    }
    if (amountUSD >= 95 && amountUSD <= 105) {
      return 'Plan Mensual ~$100';
    }
    // Generic monthly
    return `Plan Mensual $${Math.round(amountUSD)}`;
  }
  
  // Weekly plans
  if (interval === 'week') {
    return `Plan Semanal $${Math.round(amountUSD)}`;
  }
  
  // Daily plans
  if (interval === 'day') {
    return `Plan Diario $${Math.round(amountUSD)}`;
  }
  
  // Fallback: use product name or nickname if available
  if (productName && productName !== 'Unknown Plan') {
    return productName;
  }
  if (nickname) {
    return nickname;
  }
  
  // Ultimate fallback
  return `Legacy Plan $${Math.round(amountUSD)}/${interval || 'unknown'}`;
}

// Background sync function with streaming/batching to prevent OOM
async function runSync(serviceClient: any, stripe: Stripe, syncRunId: string) {
  try {
    console.log("📊 Starting background sync (ALL subscriptions, streaming mode)...");
    
    const BATCH_SIZE = 100; // Upsert every 100 records to prevent OOM
    let hasMore = true;
    let startingAfter: string | undefined;
    let totalFetched = 0;
    let totalUpserted = 0;
    const statusBreakdown: Record<string, number> = {};
    let batch: any[] = [];

    while (hasMore) {
      const params: Stripe.SubscriptionListParams = {
        limit: 100,
        expand: ["data.customer", "data.plan.product"],
      };
      if (startingAfter) params.starting_after = startingAfter;

      const response = await stripe.subscriptions.list(params);
      totalFetched += response.data.length;
      hasMore = response.has_more;

      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }

      console.log(`📦 Fetched page: ${response.data.length} (total: ${totalFetched})`);

      // Transform and add to batch
      for (const sub of response.data) {
        const customer = sub.customer;
        const plan = sub.plan;
        const product = plan?.product;

        let rawProductName: string | null = null;
        const rawNickname: string | null = plan?.nickname || null;
        
        if (typeof product === "object" && product?.name) {
          rawProductName = product.name;
        } else if (typeof product === "string") {
          rawProductName = product;
        }

        const amount = plan?.amount || 0;
        const interval = plan?.interval || 'month';
        const planName = classifyPlan(amount, interval, rawProductName, rawNickname);

        // Track status breakdown
        statusBreakdown[sub.status] = (statusBreakdown[sub.status] || 0) + 1;

        batch.push({
          stripe_subscription_id: sub.id,
          stripe_customer_id: typeof customer === "string" ? customer : customer?.id,
          customer_email: typeof customer === "object" ? customer?.email : null,
          plan_name: planName,
          plan_id: plan?.id || null,
          amount: amount,
          currency: (plan?.currency || "usd").toLowerCase(),
          interval: interval,
          status: sub.status,
          provider: 'stripe',
          trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
          trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
          cancel_reason: sub.cancellation_details?.reason || null,
          updated_at: new Date().toISOString(),
          raw_data: {
            originalProductName: rawProductName,
            originalNickname: rawNickname,
            stripeStatus: sub.status,
          }
        });

        // Flush batch when full (prevents OOM)
        if (batch.length >= BATCH_SIZE) {
          const { error: upsertError } = await serviceClient
            .from("subscriptions")
            .upsert(batch, { onConflict: "stripe_subscription_id" });

          if (upsertError) {
            console.error("❌ Batch upsert error:", upsertError);
          } else {
            totalUpserted += batch.length;
          }
          
          batch = []; // Clear memory immediately
          
          // Update progress
          await serviceClient.from("sync_runs").update({
            total_fetched: totalFetched,
            total_inserted: totalUpserted,
            checkpoint: { last_id: startingAfter, lastUpdate: new Date().toISOString() },
          }).eq("id", syncRunId);
          
          console.log(`✅ Upserted batch: ${totalUpserted} total`);
        }
      }

      // Safety limit
      if (totalFetched >= 10000) {
        console.log("⚠️ Reached 10000 subscription limit");
        break;
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      const { error: upsertError } = await serviceClient
        .from("subscriptions")
        .upsert(batch, { onConflict: "stripe_subscription_id" });

      if (upsertError) {
        console.error("❌ Final batch upsert error:", upsertError);
      } else {
        totalUpserted += batch.length;
      }
    }

    console.log(`✅ Total subscriptions: ${totalFetched} fetched, ${totalUpserted} upserted`);
    console.log("📊 Status breakdown:", JSON.stringify(statusBreakdown));

    // Note: Batching is now done inline during fetch loop above

    // Mark as completed
    await serviceClient.from("sync_runs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      total_fetched: totalFetched,
      total_inserted: totalUpserted,
      metadata: { 
        statusBreakdown,
      },
    }).eq("id", syncRunId);

    console.log("✅ Background sync completed successfully");
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Background sync error:", errorMessage);
    
    await serviceClient.from("sync_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    }).eq("id", syncRunId);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify JWT + admin role
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Admin verified");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Check if there's already a running sync
    const { data: runningSyncs } = await serviceClient
      .from("sync_runs")
      .select("id, started_at, checkpoint")
      .eq("source", "subscriptions")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1);

    if (runningSyncs && runningSyncs.length > 0) {
      const runningSync = runningSyncs[0];
      const checkpoint = runningSync.checkpoint as { lastUpdate?: string } | null;
      
      // Use checkpoint.lastUpdate for stale detection
      const lastActivity = checkpoint?.lastUpdate 
        ? new Date(checkpoint.lastUpdate).getTime()
        : new Date(runningSync.started_at).getTime();
      
      const minutesAgo = (Date.now() - lastActivity) / 1000 / 60;
      
      // If sync is stuck for more than 5 minutes, allow new one
      if (minutesAgo < 5) {
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: "Sync already in progress",
            syncRunId: runningSync.id,
            status: "running"
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } else {
        // Mark old sync as failed
        await serviceClient.from("sync_runs").update({
          status: "failed",
          error_message: `Stale: no activity for ${Math.round(minutesAgo)} minutes`,
          completed_at: new Date().toISOString(),
        }).eq("id", runningSync.id);
      }
    }

    // Create sync run record
    const { data: syncRun, error: syncRunError } = await serviceClient
      .from("sync_runs")
      .insert({
        source: "subscriptions",
        status: "running",
        started_at: new Date().toISOString(),
        checkpoint: { lastUpdate: new Date().toISOString() },
      })
      .select()
      .single();

    if (syncRunError) {
      throw syncRunError;
    }

    console.log("📝 Created sync run:", syncRun.id);

    // Use EdgeRuntime.waitUntil for background processing
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(runSync(serviceClient, stripe, syncRun.id));
      
      // Return immediately
      return new Response(
        JSON.stringify({
          success: true,
          message: "Sync started in background",
          syncRunId: syncRun.id,
          status: "running",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      // Fallback: run synchronously if EdgeRuntime not available
      await runSync(serviceClient, stripe, syncRun.id);
      
      return new Response(
        JSON.stringify({
          success: true,
          message: "Sync completed",
          syncRunId: syncRun.id,
          status: "completed",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Error:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// Handle shutdown gracefully
addEventListener('beforeunload', (ev: Event) => {
  console.log('Function shutdown');
});
