import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface StripeCustomer {
  id: string;
  email: string | null;
}

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

// Helper to fetch customer email from Stripe
async function getCustomerEmail(customerId: string, stripeSecretKey: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}`,
      {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!response.ok) {
      console.log(`Could not fetch customer ${customerId}`);
      return null;
    }

    const customer: StripeCustomer = await response.json();
    return customer.email || null;
  } catch (error) {
    console.error(`Error fetching customer ${customerId}:`, error);
    return null;
  }
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
      "https://api.stripe.com/v1/payment_intents?limit=100&expand[]=data.customer",
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
    let skippedNoEmail = 0;

    // Process transactions - need to resolve emails for those without receipt_email
    const transactions: Array<{
      stripe_payment_intent_id: string;
      stripe_customer_id: string | null;
      customer_email: string;
      amount: number;
      currency: string;
      status: string;
      failure_code: string | null;
      failure_message: string | null;
      stripe_created_at: string;
      metadata: Record<string, string>;
      source: string;
    }> = [];

    for (const pi of stripeData.data) {
      // Step 1: Try to get email from receipt_email first
      let email = pi.receipt_email || null;

      // Step 2: If no receipt_email, try to get from customer object
      if (!email && pi.customer) {
        // If customer is expanded (object), get email directly
        if (typeof pi.customer === 'object' && pi.customer !== null) {
          email = (pi.customer as unknown as StripeCustomer).email || null;
        } else {
          // Customer is just an ID string, fetch it
          email = await getCustomerEmail(pi.customer, stripeSecretKey);
        }
      }

      // Step 3: If still no email, skip this transaction (useless without email)
      if (!email) {
        skippedNoEmail++;
        console.log(`Skipping payment intent ${pi.id} - no email available`);
        continue;
      }

      // Map status correctly:
      // - succeeded → paid
      // - requires_payment_method, requires_action, canceled → failed
      let mappedStatus: string;
      if (pi.status === "succeeded") {
        mappedStatus = "paid";
        paidCount++;
      } else if (
        pi.status === "requires_payment_method" ||
        pi.status === "requires_action" ||
        pi.status === "canceled" ||
        pi.status === "requires_confirmation" ||
        pi.status === "processing"
      ) {
        mappedStatus = "failed";
        failedCount++;
      } else {
        // Any other status (like 'requires_capture') → failed
        mappedStatus = "failed";
        failedCount++;
      }

      transactions.push({
        stripe_payment_intent_id: pi.id,
        stripe_customer_id: typeof pi.customer === 'string' ? pi.customer : null,
        customer_email: email,
        amount: pi.amount,
        currency: pi.currency,
        status: mappedStatus,
        failure_code: pi.last_payment_error?.code || (mappedStatus === "failed" ? pi.status : null),
        failure_message: pi.last_payment_error?.message || (mappedStatus === "failed" ? `Stripe status: ${pi.status}` : null),
        stripe_created_at: new Date(pi.created * 1000).toISOString(),
        metadata: pi.metadata || {},
        source: "stripe",
      });
    }

    console.log(`Processing ${paidCount} paid, ${failedCount} failed, ${skippedNoEmail} skipped (no email)`);

    let syncedCount = 0;

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

      syncedCount = upsertedData?.length || 0;
      console.log(`Successfully upserted ${syncedCount} transactions`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${syncedCount} transactions (${paidCount} paid, ${failedCount} failed, ${skippedNoEmail} skipped)`,
        synced_count: syncedCount,
        paid_count: paidCount,
        failed_count: failedCount,
        skipped_no_email: skippedNoEmail,
        total_fetched: stripeData.data.length,
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
