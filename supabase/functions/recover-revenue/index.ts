import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Subscription statuses to SKIP (don't charge)
const SKIP_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"];

// Invoice statuses that should NOT be charged (extra safety)
const SKIP_INVOICE_STATUSES = ["paid", "void", "uncollectible"];

// Delay between API calls to respect rate limits (ms)
const API_DELAY_MS = 200;

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
    total_recovered: number;
    total_failed_amount: number;
    total_skipped_amount: number;
    currency: string;
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    const { hours_lookback = 24 } = await req.json();
    
    // Validate hours_lookback
    const validHours = [24, 168, 360, 720, 1440];
    if (!validHours.includes(hours_lookback)) {
      return new Response(
        JSON.stringify({ error: `Invalid hours_lookback. Valid values: ${validHours.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`🔍 Smart Recovery starting - Looking back ${hours_lookback} hours`);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2023-10-16",
    });

    // Calculate cutoff timestamp
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (hours_lookback * 60 * 60);
    console.log(`📅 Cutoff date: ${new Date(cutoffTimestamp * 1000).toISOString()}`);

    // Fetch open invoices created after cutoff
    const invoices: Stripe.Invoice[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const params: Stripe.InvoiceListParams = {
        status: "open",
        limit: 100,
        created: { gte: cutoffTimestamp },
        expand: ["data.subscription", "data.customer"],
      };
      if (startingAfter) params.starting_after = startingAfter;

      await sleep(API_DELAY_MS);
      const response = await stripe.invoices.list(params);
      invoices.push(...response.data);
      hasMore = response.has_more;
      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
    }

    console.log(`📄 Found ${invoices.length} open invoices in the last ${hours_lookback} hours`);

    const result: RecoveryResult = {
      succeeded: [],
      failed: [],
      skipped: [],
      summary: {
        total_invoices: invoices.length,
        total_recovered: 0,
        total_failed_amount: 0,
        total_skipped_amount: 0,
        currency: "usd",
      },
    };

    for (const invoice of invoices) {
      const customerEmail = typeof invoice.customer === "object" 
        ? (invoice.customer as Stripe.Customer)?.email 
        : null;
      const customerId = typeof invoice.customer === "string" 
        ? invoice.customer 
        : (invoice.customer as Stripe.Customer)?.id;

      console.log(`\n💳 Processing invoice ${invoice.id} - $${(invoice.amount_due / 100).toFixed(2)}`);

      // SAFETY CHECK 1: Skip invoices that are already paid/void/uncollectible
      if (SKIP_INVOICE_STATUSES.includes(invoice.status)) {
        console.log(`🚫 SKIPPING: Invoice ${invoice.id} is ${invoice.status}`);
        result.skipped.push({
          invoice_id: invoice.id,
          customer_email: customerEmail,
          amount_due: invoice.amount_due,
          currency: invoice.currency,
          reason: `Invoice is ${invoice.status}`,
        });
        result.summary.total_skipped_amount += invoice.amount_due;
        continue;
      }

      // SAFETY CHECK 2: Check subscription status
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
          continue;
        }
        console.log(`✅ Subscription status: ${subscription.status} - proceeding`);
      }

      // Get customer's payment methods
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

      // Try to charge with multi-card attack
      let charged = false;
      let lastError = "";
      let cardsTried = 0;

      // First, try with default (no specific payment method)
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
      } catch (error: any) {
        cardsTried++;
        lastError = error.message || "Unknown error";
        console.log(`❌ Default payment failed: ${lastError}`);
      }

      // If default failed, try other payment methods
      if (!charged && paymentMethods.length > 0) {
        for (const pm of paymentMethods) {
          if (charged) break;
          
          try {
            await sleep(API_DELAY_MS);
            console.log(`💳 Trying payment method ${pm.id} (${pm.card?.brand} ****${pm.card?.last4})...`);
            
            // Update invoice's default payment method and retry
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
          } catch (error: any) {
            cardsTried++;
            lastError = error.message || "Unknown error";
            console.log(`❌ Card ${pm.card?.last4} failed: ${lastError}`);
          }
        }
      }

      // If all cards failed
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
    }

    console.log(`\n🏁 Smart Recovery Complete!`);
    console.log(`✅ Recovered: $${(result.summary.total_recovered / 100).toFixed(2)}`);
    console.log(`❌ Failed: $${(result.summary.total_failed_amount / 100).toFixed(2)}`);
    console.log(`🚫 Skipped: $${(result.summary.total_skipped_amount / 100).toFixed(2)}`);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("❌ Fatal error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
