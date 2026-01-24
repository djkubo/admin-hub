import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SECURITY: JWT-based admin verification
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

// Background sync function
async function runSync(serviceClient: any, stripe: any, syncRunId: string) {
  try {
    console.log("📊 Starting background sync...");
    
    let subscriptions: any[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;
    const limit = 100;

    while (hasMore) {
      const params: any = {
        limit,
        expand: ["data.customer", "data.plan.product"],
      };
      if (startingAfter) params.starting_after = startingAfter;

      const response = await stripe.subscriptions.list(params);
      subscriptions = subscriptions.concat(response.data);
      hasMore = response.has_more;

      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }

      console.log(`📦 Fetched ${subscriptions.length} subscriptions so far...`);

      // Update progress in sync_runs
      await serviceClient.from("sync_runs").update({
        total_fetched: subscriptions.length,
        checkpoint: { last_id: startingAfter },
      }).eq("id", syncRunId);

      if (subscriptions.length >= 5000) {
        console.log("⚠️ Reached 5000 subscription limit");
        break;
      }
    }

    console.log(`✅ Total subscriptions fetched: ${subscriptions.length}`);

    const records = subscriptions.map((sub) => {
      const customer = sub.customer;
      const plan = sub.plan;
      const product = plan?.product;

      let planName = "Unknown Plan";
      if (typeof product === "object" && product?.name) {
        planName = product.name;
      } else if (plan?.nickname) {
        planName = plan.nickname;
      } else if (typeof product === "string") {
        planName = product;
      }

      return {
        stripe_subscription_id: sub.id,
        stripe_customer_id: typeof customer === "string" ? customer : customer?.id,
        customer_email: typeof customer === "object" ? customer?.email : null,
        plan_name: planName,
        plan_id: plan?.id || null,
        amount: plan?.amount || 0,
        currency: (plan?.currency || "usd").toLowerCase(),
        interval: plan?.interval || "month",
        status: sub.status,
        provider: 'stripe',
        trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
        trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
        current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
        canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
        cancel_reason: sub.cancellation_details?.reason || null,
        updated_at: new Date().toISOString(),
      };
    });

    const BATCH_SIZE = 500;
    let upserted = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const { error: upsertError } = await serviceClient
        .from("subscriptions")
        .upsert(batch, { onConflict: "stripe_subscription_id" });

      if (upsertError) {
        console.error("❌ Upsert error:", upsertError);
        throw upsertError;
      }

      upserted += batch.length;
      
      // Update progress
      await serviceClient.from("sync_runs").update({
        total_inserted: upserted,
      }).eq("id", syncRunId);
      
      console.log(`📝 Upserted ${upserted}/${records.length} subscriptions`);
    }

    // Mark as completed
    await serviceClient.from("sync_runs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      total_fetched: subscriptions.length,
      total_inserted: upserted,
      metadata: { planCount: records.length },
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

serve(async (req: Request) => {
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
      .select("id, started_at")
      .eq("source", "subscriptions")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1);

    if (runningSyncs && runningSyncs.length > 0) {
      const runningSync = runningSyncs[0];
      const startedAt = new Date(runningSync.started_at);
      const minutesAgo = (Date.now() - startedAt.getTime()) / 1000 / 60;
      
      // If sync is stuck for more than 10 minutes, allow new one
      if (minutesAgo < 10) {
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
          error_message: "Timeout - sync took too long",
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
      })
      .select()
      .single();

    if (syncRunError) {
      throw syncRunError;
    }

    console.log("📝 Created sync run:", syncRun.id);

    // Use EdgeRuntime.waitUntil for background processing
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      // @ts-ignore
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
addEventListener('beforeunload', (ev: any) => {
  console.log('Function shutdown:', ev.detail?.reason);
});
