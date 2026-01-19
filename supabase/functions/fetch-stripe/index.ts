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
  customer: string | StripeCustomer | null;
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

const customerEmailCache = new Map<string, string | null>();

async function getCustomerEmail(customerId: string, stripeSecretKey: string): Promise<string | null> {
  if (customerEmailCache.has(customerId)) {
    return customerEmailCache.get(customerId) || null;
  }

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}`,
      {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
        },
      }
    );

    if (!response.ok) {
      customerEmailCache.set(customerId, null);
      return null;
    }

    const customer: StripeCustomer = await response.json();
    customerEmailCache.set(customerId, customer.email);
    return customer.email || null;
  } catch {
    customerEmailCache.set(customerId, null);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let fetchAll = false;
    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
    } catch {
      // No body
    }

    console.log(`🔄 Stripe Sync - fetchAll: ${fetchAll}`);

    let totalSynced = 0;
    let totalClients = 0;
    let paidCount = 0;
    let failedCount = 0;
    let skippedNoEmail = 0;
    let hasMore = true;
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = fetchAll ? 50 : 1; // Reduced to 50 pages (5000 tx) to avoid timeout
    const BATCH_SIZE = 100;

    // Process page by page and save immediately to avoid timeout
    while (hasMore && pageCount < maxPages) {
      const url = new URL("https://api.stripe.com/v1/payment_intents");
      url.searchParams.set("limit", "100");
      url.searchParams.append("expand[]", "data.customer");
      if (cursor) {
        url.searchParams.set("starting_after", cursor);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Stripe API error:", errorText);
        break;
      }

      const data: StripeListResponse = await response.json();
      
      if (data.data.length === 0) break;

      // Process this page immediately
      const transactions: Array<Record<string, unknown>> = [];
      const clientsMap = new Map<string, Record<string, unknown>>();

      for (const pi of data.data) {
        let email = pi.receipt_email || null;

        if (!email && pi.customer) {
          if (typeof pi.customer === 'object' && pi.customer !== null) {
            email = pi.customer.email || null;
          } else if (typeof pi.customer === 'string') {
            email = await getCustomerEmail(pi.customer, stripeSecretKey);
          }
        }

        if (!email) {
          skippedNoEmail++;
          continue;
        }

        let mappedStatus: string;
        if (pi.status === "succeeded") {
          mappedStatus = "paid";
          paidCount++;
        } else {
          mappedStatus = "failed";
          failedCount++;
        }

        transactions.push({
          stripe_payment_intent_id: pi.id,
          stripe_customer_id: typeof pi.customer === 'string' ? pi.customer : (pi.customer as StripeCustomer)?.id || null,
          customer_email: email,
          amount: pi.amount,
          currency: pi.currency,
          status: mappedStatus,
          failure_code: pi.last_payment_error?.code || (mappedStatus === "failed" ? pi.status : null),
          failure_message: pi.last_payment_error?.message || null,
          stripe_created_at: new Date(pi.created * 1000).toISOString(),
          metadata: pi.metadata || {},
          source: "stripe",
        });

        // Aggregate client
        const existing = clientsMap.get(email) || { 
          email, 
          payment_status: 'none', 
          total_paid: 0,
          status: 'active',
          last_sync: new Date().toISOString()
        };
        
        if (mappedStatus === 'paid') {
          existing.payment_status = 'paid';
          existing.total_paid = (existing.total_paid as number) + (pi.amount / 100);
        } else if (existing.payment_status !== 'paid') {
          existing.payment_status = 'failed';
        }
        clientsMap.set(email, existing);
      }

      // Save transactions immediately
      if (transactions.length > 0) {
        const { error: txError, data: txData } = await supabase
          .from("transactions")
          .upsert(transactions, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: false })
          .select("id");

        if (txError) {
          console.error(`Page ${pageCount + 1} tx error:`, txError.message);
        } else {
          totalSynced += txData?.length || 0;
        }
      }

      // Save clients immediately
      const clientsToSave = Array.from(clientsMap.values());
      if (clientsToSave.length > 0) {
        const { error: clientError, data: clientData } = await supabase
          .from("clients")
          .upsert(clientsToSave, { onConflict: "email", ignoreDuplicates: false })
          .select("id");

        if (!clientError) {
          totalClients += clientData?.length || 0;
        }
      }

      hasMore = data.has_more && fetchAll;
      cursor = data.data[data.data.length - 1].id;
      pageCount++;
      
      console.log(`📄 Page ${pageCount}: saved ${transactions.length} tx (total: ${totalSynced})`);
    }

    console.log(`✅ Done: ${totalSynced} transactions, ${totalClients} clients`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${totalSynced} transactions`,
        synced_transactions: totalSynced,
        synced_clients: totalClients,
        paid_count: paidCount,
        failed_count: failedCount,
        skipped_no_email: skippedNoEmail,
        pages_fetched: pageCount,
        has_more: hasMore,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
