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

serve(async (req) => {
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
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", user.email);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

    const serviceClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    console.log("📊 Fetching subscriptions from Stripe...");

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
        currency: (plan?.currency || "usd").toLowerCase(), // Normalize to lowercase
        interval: plan?.interval || "month",
        status: sub.status,
        provider: 'stripe', // Add provider
        trial_start: sub.trial_start 
          ? new Date(sub.trial_start * 1000).toISOString() 
          : null,
        trial_end: sub.trial_end 
          ? new Date(sub.trial_end * 1000).toISOString() 
          : null,
        current_period_start: sub.current_period_start 
          ? new Date(sub.current_period_start * 1000).toISOString() 
          : null,
        current_period_end: sub.current_period_end 
          ? new Date(sub.current_period_end * 1000).toISOString() 
          : null,
        canceled_at: sub.canceled_at 
          ? new Date(sub.canceled_at * 1000).toISOString() 
          : null,
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
      console.log(`📝 Upserted ${upserted}/${records.length} subscriptions`);
    }

    const planStats: Record<string, { count: number; revenue: number }> = {};
    for (const rec of records) {
      if (rec.status === "active" || rec.status === "trialing") {
        const planName = rec.plan_name || "Unknown";
        if (!planStats[planName]) {
          planStats[planName] = { count: 0, revenue: 0 };
        }
        planStats[planName].count += 1;
        planStats[planName].revenue += rec.amount;
      }
    }

    const sortedPlans = Object.entries(planStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue);

    console.log("📊 Plan breakdown:", sortedPlans);

    return new Response(
      JSON.stringify({
        success: true,
        total: subscriptions.length,
        upserted,
        planBreakdown: sortedPlans,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const origin = req.headers.get("origin");
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Error fetching subscriptions:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
