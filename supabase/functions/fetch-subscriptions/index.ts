// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  // Use getUser() instead of getClaims() for compatibility
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

async function processPage(
  serviceClient: SupabaseClient<any, any, any>,
  stripe: Stripe,
  cursor: string | null,
  limit: number
): Promise<{ upserted: number; hasMore: boolean; nextCursor: string | null }> {
  const params: Stripe.SubscriptionListParams = {
    limit: Math.min(limit, 100),
    expand: ["data.customer", "data.plan.product"],
  };
  if (cursor) params.starting_after = cursor;

  const response = await stripe.subscriptions.list(params);
  const subscriptions = response.data;
  const hasMore = response.has_more;
  const nextCursor = subscriptions.length > 0 ? subscriptions[subscriptions.length - 1].id : null;

  const records = subscriptions.map((sub: any) => {
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

  if (records.length > 0) {
    const { error: upsertError } = await serviceClient
      .from("subscriptions")
      .upsert(records, { onConflict: "stripe_subscription_id" });

    if (upsertError) {
      console.error("❌ Upsert error:", upsertError);
      throw upsertError;
    }
  }

  return { upserted: records.length, hasMore, nextCursor };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

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

    const body = await req.json().catch(() => ({}));
    let cursor = body.cursor ?? null;
    const syncRunId = body.syncRunId ?? null;
    const limit = body.limit && body.limit > 0 ? Math.min(body.limit, 100) : 100;

    let activeSyncId = syncRunId;

    if (!activeSyncId) {
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
        
        if (minutesAgo < 10) {
          return new Response(
            JSON.stringify({ 
              success: false, 
              error: "sync_already_running",
              syncRunId: runningSync.id,
              status: "running"
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        await serviceClient.from("sync_runs").update({
          status: "failed",
          error_message: "Timeout - sync took too long",
          completed_at: new Date().toISOString(),
        }).eq("id", runningSync.id);
      }

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

      activeSyncId = syncRun.id;
      console.log("📝 Created sync run:", activeSyncId);
    }

    if (activeSyncId && !cursor) {
      const { data: syncRun } = await serviceClient
        .from("sync_runs")
        .select("checkpoint")
        .eq("id", activeSyncId)
        .single();
      const checkpoint = (syncRun?.checkpoint as { cursor?: string | null } | null) ?? null;
      cursor = checkpoint?.cursor ?? null;
    }

    const result = await processPage(serviceClient, stripe, cursor, limit);

    const { data: currentRun } = await serviceClient
      .from("sync_runs")
      .select("total_fetched, total_inserted")
      .eq("id", activeSyncId)
      .single();

    await serviceClient.from("sync_runs").update({
      status: result.hasMore ? "continuing" : "completed",
      completed_at: result.hasMore ? null : new Date().toISOString(),
      checkpoint: result.hasMore ? { cursor: result.nextCursor } : null,
      total_fetched: (currentRun?.total_fetched || 0) + result.upserted,
      total_inserted: (currentRun?.total_inserted || 0) + result.upserted,
    }).eq("id", activeSyncId);

    return new Response(
      JSON.stringify({
        success: true,
        syncRunId: activeSyncId,
        status: result.hasMore ? "continuing" : "completed",
        upserted: result.upserted,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        duration_ms: Date.now() - startTime,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

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
