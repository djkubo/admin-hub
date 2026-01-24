import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

interface StripeLineItem {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  quantity: number;
  price?: {
    id: string;
    nickname: string | null;
    unit_amount: number | null;
    recurring?: {
      interval: string;
      interval_count: number;
    } | null;
    product?: string | {
      id: string;
      name: string;
    };
  };
}

interface StripeInvoice {
  id: string;
  number: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  subtotal: number;
  total: number;
  currency: string;
  status: string;
  period_end: number;
  next_payment_attempt: number | null;
  due_date: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  attempt_count: number;
  billing_reason: string | null;
  collection_method: string | null;
  description: string | null;
  payment_intent: string | { id: string } | null;
  charge: string | null;
  default_payment_method: string | { id: string } | null;
  last_finalization_error: { message: string; code: string } | null;
  subscription?: {
    id: string;
    status: string;
    items?: {
      data: Array<{
        price?: {
          id: string;
          nickname: string | null;
          recurring?: {
            interval: string;
          } | null;
          product?: string | {
            id: string;
            name: string;
          };
        };
      }>;
    };
  } | string | null;
  lines?: {
    data: StripeLineItem[];
  };
}

const EXCLUDED_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired", "unpaid"];
const EXCLUDED_INVOICE_STATUSES = ["void", "uncollectible", "paid"];

// Helper to extract plan info from subscription or lines
function extractPlanInfo(invoice: StripeInvoice): { planName: string | null; planInterval: string | null; productName: string | null } {
  let planName: string | null = null;
  let planInterval: string | null = null;
  let productName: string | null = null;

  // Try from subscription first (expanded)
  if (invoice.subscription && typeof invoice.subscription === 'object') {
    const sub = invoice.subscription;
    if (sub.items?.data?.[0]?.price) {
      const price = sub.items.data[0].price;
      planName = price.nickname || null;
      planInterval = price.recurring?.interval || null;
      
      if (price.product && typeof price.product === 'object') {
        productName = price.product.name;
      }
    }
  }

  // Fallback: try from invoice lines
  if (!planName && invoice.lines?.data?.length) {
    const firstLine = invoice.lines.data[0];
    if (firstLine.price) {
      planName = firstLine.price.nickname || firstLine.description || null;
      planInterval = firstLine.price.recurring?.interval || null;
      
      if (firstLine.price.product && typeof firstLine.price.product === 'object') {
        productName = firstLine.price.product.name;
      }
    } else if (firstLine.description) {
      planName = firstLine.description;
    }
  }

  // Format interval to Spanish
  if (planInterval) {
    const intervalMap: Record<string, string> = {
      'day': 'Diario',
      'week': 'Semanal',
      'month': 'Mensual',
      'year': 'Anual',
    };
    planInterval = intervalMap[planInterval] || planInterval;
  }

  return { planName, planInterval, productName };
}

Deno.serve(async (req) => {
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

    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("🧾 Starting ENRICHED Stripe Invoices fetch...");

    // Fetch draft invoices with valid expansion (max 4 levels)
    const draftResponse = await fetch(
      "https://api.stripe.com/v1/invoices?status=draft&limit=100" +
      "&expand[]=data.subscription" +
      "&expand[]=data.lines.data.price" +
      "&expand[]=data.customer",
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

    // Fetch open invoices with valid expansion (max 4 levels)
    const openResponse = await fetch(
      "https://api.stripe.com/v1/invoices?status=open&limit=100" +
      "&expand[]=data.subscription" +
      "&expand[]=data.lines.data.price" +
      "&expand[]=data.customer",
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

    // Filter out invoices from canceled subscriptions
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
      // Extract enriched plan info
      const { planName, planInterval, productName } = extractPlanInfo(invoice);
      
      // Get subscription ID
      const subscriptionId = invoice.subscription 
        ? (typeof invoice.subscription === 'object' ? invoice.subscription.id : invoice.subscription)
        : null;

      // Get payment intent ID
      const paymentIntentId = invoice.payment_intent
        ? (typeof invoice.payment_intent === 'object' ? invoice.payment_intent.id : invoice.payment_intent)
        : null;

      // Get default payment method ID  
      const defaultPaymentMethod = invoice.default_payment_method
        ? (typeof invoice.default_payment_method === 'object' ? invoice.default_payment_method.id : invoice.default_payment_method)
        : null;

      // Extract line items for storage
      const lineItems = invoice.lines?.data?.map(line => ({
        id: line.id,
        amount: line.amount,
        currency: line.currency,
        description: line.description,
        quantity: line.quantity,
        price_id: line.price?.id,
        price_nickname: line.price?.nickname,
        unit_amount: line.price?.unit_amount,
        interval: line.price?.recurring?.interval,
        product_name: line.price?.product && typeof line.price.product === 'object' 
          ? line.price.product.name 
          : null,
      })) || null;

      const invoiceRecord = {
        stripe_invoice_id: invoice.id,
        invoice_number: invoice.number,
        customer_email: invoice.customer_email,
        customer_name: invoice.customer_name,
        stripe_customer_id: invoice.customer,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid,
        amount_remaining: invoice.amount_remaining,
        subtotal: invoice.subtotal,
        total: invoice.total,
        currency: invoice.currency,
        status: invoice.status,
        period_end: invoice.period_end 
          ? new Date(invoice.period_end * 1000).toISOString() 
          : null,
        next_payment_attempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : null,
        due_date: invoice.due_date
          ? new Date(invoice.due_date * 1000).toISOString()
          : null,
        hosted_invoice_url: invoice.hosted_invoice_url,
        pdf_url: invoice.invoice_pdf,
        subscription_id: subscriptionId,
        plan_name: planName,
        plan_interval: planInterval,
        product_name: productName,
        attempt_count: invoice.attempt_count || 0,
        billing_reason: invoice.billing_reason,
        collection_method: invoice.collection_method,
        description: invoice.description,
        payment_intent_id: paymentIntentId,
        charge_id: invoice.charge,
        default_payment_method: defaultPaymentMethod,
        last_finalization_error: invoice.last_finalization_error?.message || null,
        lines: lineItems,
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
        console.log(`✅ Upserted: ${invoice.number || invoice.id} - ${invoice.customer_name || invoice.customer_email} - ${planName || 'N/A'} (${planInterval || 'N/A'})`);
      }
    }

    // Cleanup old/settled invoices
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

    console.log(`✅ ENRICHED Sync complete: ${upsertedCount} upserted, ${errorCount} errors`);
    console.log(`💰 Total pending amount (actionable): $${(totalPending / 100).toFixed(2)}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${upsertedCount} pending invoices with enriched data`,
        synced: upsertedCount,
        draftCount: filteredInvoices.filter(i => i.status === "draft").length,
        openCount: filteredInvoices.filter(i => i.status === "open").length,
        excludedCount: allRawInvoices.length - filteredInvoices.length,
        totalPending: totalPending,
        errors: errorCount,
        enrichedFields: [
          'customer_name', 'invoice_number', 'plan_name', 'plan_interval', 
          'product_name', 'attempt_count', 'billing_reason', 'pdf_url', 
          'payment_intent_id', 'lines'
        ],
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
