import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

interface StripeInvoice {
  id: string;
  customer_email: string | null;
  customer: string;
  amount_due: number;
  currency: string;
  status: string;
  period_end: number;
  next_payment_attempt: number | null;
  hosted_invoice_url: string | null;
  subscription?: {
    id: string;
    status: string;
  } | string | null;
}

const EXCLUDED_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired", "unpaid"];
const EXCLUDED_INVOICE_STATUSES = ["void", "uncollectible", "paid"];

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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getUser(token);
    
    if (claimsError || !claimsData?.user) {
      console.error("Auth error:", claimsError);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", claimsData.user.email);

    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("🧾 Starting Stripe Invoices fetch with subscription filter...");

    const draftResponse = await fetch(
      "https://api.stripe.com/v1/invoices?status=draft&limit=100&expand[]=data.subscription",
      {
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!draftResponse.ok) {
      const error = await draftResponse.text();
      throw new Error(`Stripe API error (draft): ${error}`);
    }

    const draftData = await draftResponse.json();
    console.log(`📄 Found ${draftData.data.length} draft invoices (raw)`);

    const openResponse = await fetch(
      "https://api.stripe.com/v1/invoices?status=open&limit=100&expand[]=data.subscription",
      {
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!openResponse.ok) {
      const error = await openResponse.text();
      throw new Error(`Stripe API error (open): ${error}`);
    }

    const openData = await openResponse.json();
    console.log(`📄 Found ${openData.data.length} open invoices (raw)`);

    const allRawInvoices: StripeInvoice[] = [...draftData.data, ...openData.data];
    console.log(`📊 Total raw invoices: ${allRawInvoices.length}`);

    const filteredInvoices = allRawInvoices.filter((invoice) => {
      if (!invoice.subscription) {
        console.log(`✅ Invoice ${invoice.id}: No subscription, including`);
        return true;
      }

      const sub = invoice.subscription;
      if (typeof sub === "object" && sub.status) {
        const isExcluded = EXCLUDED_SUBSCRIPTION_STATUSES.includes(sub.status);
        if (isExcluded) {
          console.log(`🚫 Invoice ${invoice.id}: Subscription ${sub.id} is ${sub.status}, EXCLUDING`);
          return false;
        }
        console.log(`✅ Invoice ${invoice.id}: Subscription ${sub.id} is ${sub.status}, including`);
        return true;
      }

      console.log(`⚠️ Invoice ${invoice.id}: Subscription is string ID, including`);
      return true;
    });

    console.log(`📊 Filtered invoices (actionable): ${filteredInvoices.length}`);
    console.log(`🚫 Excluded: ${allRawInvoices.length - filteredInvoices.length} invoices from canceled/inactive subscriptions`);

    let upsertedCount = 0;
    let errorCount = 0;

    for (const invoice of filteredInvoices) {
      const invoiceRecord = {
        stripe_invoice_id: invoice.id,
        customer_email: invoice.customer_email,
        stripe_customer_id: invoice.customer,
        amount_due: invoice.amount_due,
        currency: invoice.currency,
        status: invoice.status,
        period_end: invoice.period_end 
          ? new Date(invoice.period_end * 1000).toISOString() 
          : null,
        next_payment_attempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : null,
        hosted_invoice_url: invoice.hosted_invoice_url,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("invoices")
        .upsert(invoiceRecord, { 
          onConflict: "stripe_invoice_id",
          ignoreDuplicates: false 
        });

      if (error) {
        console.error(`❌ Error upserting invoice ${invoice.id}:`, error);
        errorCount++;
      } else {
        upsertedCount++;
      }
    }

    const currentValidInvoiceIds = filteredInvoices.map((i) => i.id);
    
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("stripe_invoice_id, status");

    if (existingInvoices) {
      const toRemove = existingInvoices
        .filter((inv) => {
          if (!currentValidInvoiceIds.includes(inv.stripe_invoice_id)) {
            return true;
          }
          if (EXCLUDED_INVOICE_STATUSES.includes(inv.status)) {
            return true;
          }
          return false;
        })
        .map((inv) => inv.stripe_invoice_id);

      if (toRemove.length > 0) {
        const { error: deleteError } = await supabase
          .from("invoices")
          .delete()
          .in("stripe_invoice_id", toRemove);

        if (deleteError) {
          console.error("❌ Error cleaning up old invoices:", deleteError);
        } else {
          console.log(`🧹 Cleaned up ${toRemove.length} settled/excluded invoices`);
        }
      }
    }

    const totalPending = filteredInvoices.reduce((sum, inv) => sum + inv.amount_due, 0);

    console.log(`✅ Sync complete: ${upsertedCount} upserted, ${errorCount} errors`);
    console.log(`💰 Total pending amount (actionable): $${(totalPending / 100).toFixed(2)}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${upsertedCount} pending invoices`,
        draftCount: filteredInvoices.filter(i => i.status === "draft").length,
        openCount: filteredInvoices.filter(i => i.status === "open").length,
        excludedCount: allRawInvoices.length - filteredInvoices.length,
        totalPending: totalPending,
        errors: errorCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const origin = req.headers.get("origin");
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Fatal error:", errorMessage);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
