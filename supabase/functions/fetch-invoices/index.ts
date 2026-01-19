import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

// Subscription statuses to EXCLUDE from pending invoices
const EXCLUDED_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired", "unpaid"];

// Invoice statuses to exclude (not actionable)
const EXCLUDED_INVOICE_STATUSES = ["void", "uncollectible", "paid"];

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("🧾 Starting Stripe Invoices fetch with subscription filter...");

    // Fetch draft invoices with subscription expanded
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

    // Fetch open invoices with subscription expanded
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

    // Combine and filter
    const allRawInvoices: StripeInvoice[] = [...draftData.data, ...openData.data];
    console.log(`📊 Total raw invoices: ${allRawInvoices.length}`);

    // Filter out invoices with canceled/void/uncollectible subscriptions
    const filteredInvoices = allRawInvoices.filter((invoice) => {
      // If no subscription, include the invoice (one-time charge)
      if (!invoice.subscription) {
        console.log(`✅ Invoice ${invoice.id}: No subscription, including`);
        return true;
      }

      // Check subscription status
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

      // If subscription is just an ID string, include it (can't determine status)
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
        amount_due: invoice.amount_due, // Already in cents from Stripe
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

    // Clean up: Remove invoices that are no longer draft/open OR were excluded
    const currentValidInvoiceIds = filteredInvoices.map((i) => i.id);
    
    // Get all invoices in DB
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("stripe_invoice_id, status");

    if (existingInvoices) {
      // Find invoices to remove (either not in Stripe anymore, or in excluded statuses, or paid)
      const toRemove = existingInvoices
        .filter((inv) => {
          // If not in current valid list, remove it
          if (!currentValidInvoiceIds.includes(inv.stripe_invoice_id)) {
            return true;
          }
          // If status is one we should exclude, remove it
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

    // Calculate totals for response (only filtered invoices)
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
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Fatal error:", errorMessage);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
