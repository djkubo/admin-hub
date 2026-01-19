import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface StripePaymentIntent {
  id: string;
  customer: string | null;
  amount: number;
  currency: string;
  status: string;
  last_payment_error?: {
    code?: string;
    message?: string;
  } | null;
  created: number;
  metadata: Record<string, string>;
  receipt_email?: string | null;
}

interface StripeListResponse {
  data: StripePaymentIntent[];
  has_more: boolean;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      console.error("STRIPE_SECRET_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Stripe API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("Fetching last 100 payment intents from Stripe (all statuses)...");

    // Fetch the last 100 PaymentIntents regardless of status
    const paymentsResponse = await fetch(
      "https://api.stripe.com/v1/payment_intents?limit=100",
      {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!paymentsResponse.ok) {
      const errorText = await paymentsResponse.text();
      console.error("Stripe API error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to fetch from Stripe", details: errorText }),
        { status: paymentsResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stripeData: StripeListResponse = await paymentsResponse.json();
    console.log(`Fetched ${stripeData.data.length} payment intents from Stripe`);

    // Counters for summary
    let paidCount = 0;
    let failedCount = 0;

    // Prepare transactions for upsert - map ALL payment intents
    const transactions = stripeData.data.map((pi) => {
      // Map status: succeeded → paid, everything else → failed
      let mappedStatus: string;
      if (pi.status === "succeeded") {
        mappedStatus = "paid";
        paidCount++;
      } else {
        mappedStatus = "failed";
        failedCount++;
      }

      return {
        stripe_payment_intent_id: pi.id,
        stripe_customer_id: pi.customer,
        customer_email: pi.receipt_email || null,
        amount: pi.amount,
        currency: pi.currency,
        status: mappedStatus,
        failure_code: pi.last_payment_error?.code || (mappedStatus === "failed" ? pi.status : null),
        failure_message: pi.last_payment_error?.message || (mappedStatus === "failed" ? `Status: ${pi.status}` : null),
        stripe_created_at: new Date(pi.created * 1000).toISOString(),
        metadata: pi.metadata || {},
        source: "stripe",
      };
    });

    console.log(`Processing ${paidCount} paid and ${failedCount} failed transactions`);

    if (transactions.length > 0) {
      // Upsert transactions (update if exists, insert if new)
      const { data: upsertedData, error: upsertError } = await supabase
        .from("transactions")
        .upsert(transactions, { 
          onConflict: "stripe_payment_intent_id",
          ignoreDuplicates: false 
        })
        .select();

      if (upsertError) {
        console.error("Error upserting transactions:", upsertError);
        return new Response(
          JSON.stringify({ error: "Failed to save transactions", details: upsertError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`Successfully upserted ${upsertedData?.length || 0} transactions`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Processed ${transactions.length} payment intents`,
        synced_count: transactions.length,
        paid_count: paidCount,
        failed_count: failedCount,
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
