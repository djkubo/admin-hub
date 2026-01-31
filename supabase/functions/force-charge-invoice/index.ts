import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ORIGINS = [
  "https://id-preview--9d074359-befd-41d0-9307-39b75ab20410.lovable.app",
  "https://zen-admin-joy.lovable.app",
  "https://lovable.dev",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(origin: string | null) {
  const isAllowed = origin && ALLOWED_ORIGINS.some(o => origin.startsWith(o.replace(/\/$/, '')));
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
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

    const invoice = await stripe.invoices.retrieve(stripe_invoice_id);
    console.log("📄 Invoice status:", invoice.status);

    let finalizedInvoice = invoice;

    if (invoice.status === "draft") {
      console.log("📝 Finalizing draft invoice...");
      finalizedInvoice = await stripe.invoices.finalizeInvoice(stripe_invoice_id);
      console.log("✅ Invoice finalized, new status:", finalizedInvoice.status);
    }

    if (finalizedInvoice.status === "open") {
      console.log("💰 Attempting to pay invoice...");
      const paidInvoice = await stripe.invoices.pay(stripe_invoice_id);
      console.log("✅ Payment attempted, status:", paidInvoice.status);

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

    return new Response(
      JSON.stringify({ 
        success: false, 
        status: finalizedInvoice.status,
        message: `Invoice is ${finalizedInvoice.status}, cannot charge`
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const origin = req.headers.get("origin");
    console.error("❌ Error charging invoice:", error);
    
    const stripeError = error as { 
      type?: string; 
      message?: string; 
      code?: string; 
      decline_code?: string;
      raw?: { message?: string; code?: string; decline_code?: string };
    };
    
    const errorMsg = stripeError.message?.toLowerCase() || "";
    const isPaymentError = 
      stripeError.type === "StripeCardError" ||
      stripeError.type === "StripeInvalidRequestError" ||
      stripeError.code === "card_declined" ||
      stripeError.code === "insufficient_funds" ||
      stripeError.code === "payment_intent_authentication_failure" ||
      stripeError.code === "invoice_no_longer_payable" ||
      errorMsg.includes("insufficient funds") ||
      errorMsg.includes("sufficient funds") ||
      errorMsg.includes("card") ||
      errorMsg.includes("declined") ||
      errorMsg.includes("payment") ||
      errorMsg.includes("charge") ||
      errorMsg.includes("can no longer be paid") ||
      errorMsg.includes("voiding") ||
      errorMsg.includes("uncollectible");
    
    if (isPaymentError) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: stripeError.message || "Payment failed",
          code: stripeError.code || stripeError.raw?.code,
          decline_code: stripeError.decline_code || stripeError.raw?.decline_code,
          message: `Pago rechazado: ${stripeError.message || "Error de tarjeta"}`
        }),
        { status: 200, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
