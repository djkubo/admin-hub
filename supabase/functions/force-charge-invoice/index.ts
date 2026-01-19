import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight requests
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

    // Verify the user is authenticated
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", user.email);

    const { stripe_invoice_id } = await req.json();

    if (!stripe_invoice_id) {
      return new Response(
        JSON.stringify({ error: "stripe_invoice_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("💳 Force charging invoice:", stripe_invoice_id);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2023-10-16",
    });

    // Get invoice current status
    const invoice = await stripe.invoices.retrieve(stripe_invoice_id);
    console.log("📄 Invoice status:", invoice.status);

    let finalizedInvoice = invoice;

    // If draft, finalize it first
    if (invoice.status === "draft") {
      console.log("📝 Finalizing draft invoice...");
      finalizedInvoice = await stripe.invoices.finalizeInvoice(stripe_invoice_id);
      console.log("✅ Invoice finalized, new status:", finalizedInvoice.status);
    }

    // If open, attempt to pay
    if (finalizedInvoice.status === "open") {
      console.log("💰 Attempting to pay invoice...");
      const paidInvoice = await stripe.invoices.pay(stripe_invoice_id);
      console.log("✅ Payment attempted, status:", paidInvoice.status);

      // Update local database
      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      await serviceClient
        .from("invoices")
        .update({ 
          status: paidInvoice.status,
          updated_at: new Date().toISOString()
        })
        .eq("stripe_invoice_id", stripe_invoice_id);

      return new Response(
        JSON.stringify({ 
          success: true, 
          status: paidInvoice.status,
          amount_paid: paidInvoice.amount_paid,
          message: paidInvoice.status === "paid" 
            ? "Invoice charged successfully!" 
            : "Payment initiated, check Stripe for status"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Already paid or in invalid state
    return new Response(
      JSON.stringify({ 
        success: false, 
        status: finalizedInvoice.status,
        message: `Invoice is ${finalizedInvoice.status}, cannot charge`
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("❌ Error charging invoice:", error);
    
    // Handle Stripe-specific errors - they have a 'type' or 'code' property
    const stripeError = error as { 
      type?: string; 
      message?: string; 
      code?: string; 
      decline_code?: string;
      raw?: { message?: string; code?: string; decline_code?: string };
    };
    
    // Check for card/payment errors (Stripe SDK throws these for declined cards)
    const isPaymentError = 
      stripeError.type === "StripeCardError" ||
      stripeError.code === "card_declined" ||
      stripeError.code === "insufficient_funds" ||
      stripeError.message?.includes("insufficient funds") ||
      stripeError.message?.includes("card") ||
      stripeError.message?.includes("declined");
    
    if (isPaymentError) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: stripeError.message || "Payment failed",
          code: stripeError.code || stripeError.raw?.code,
          decline_code: stripeError.decline_code || stripeError.raw?.decline_code,
          message: `Pago rechazado: ${stripeError.message || "Error de tarjeta"}`
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
