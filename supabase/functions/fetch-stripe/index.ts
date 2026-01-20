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

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let fetchAll = false;
    let startDate: number | null = null;
    let endDate: number | null = null;
    
    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate) {
        startDate = Math.floor(new Date(body.startDate).getTime() / 1000);
      }
      if (body.endDate) {
        endDate = Math.floor(new Date(body.endDate).getTime() / 1000);
      }
    } catch {
      // No body
    }

    console.log(`🔄 Stripe Sync - fetchAll: ${fetchAll}, startDate: ${startDate}, endDate: ${endDate}`);

    let totalSynced = 0;
    let totalClients = 0;
    let paidCount = 0;
    let failedCount = 0;
    let skippedNoEmail = 0;
    let hasMore = true;
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = fetchAll ? 50 : 1;

    while (hasMore && pageCount < maxPages) {
      const url = new URL("https://api.stripe.com/v1/payment_intents");
      url.searchParams.set("limit", "100");
      url.searchParams.append("expand[]", "data.customer");
      
      if (startDate) {
        url.searchParams.set("created[gte]", startDate.toString());
      }
      if (endDate) {
        url.searchParams.set("created[lte]", endDate.toString());
      }
      
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

        // NORMALIZED: payment_key = payment_intent_id for perfect dedup
        transactions.push({
          stripe_payment_intent_id: pi.id,
          payment_key: pi.id, // CANONICAL dedup key
          stripe_customer_id: typeof pi.customer === 'string' ? pi.customer : (pi.customer as StripeCustomer)?.id || null,
          customer_email: email,
          amount: pi.amount, // Already in cents from Stripe
          currency: pi.currency.toLowerCase(), // Normalize to lowercase
          status: mappedStatus,
          failure_code: pi.last_payment_error?.code || (mappedStatus === "failed" ? pi.status : null),
          failure_message: pi.last_payment_error?.message || null,
          stripe_created_at: new Date(pi.created * 1000).toISOString(),
          metadata: pi.metadata || {},
          source: "stripe",
        });

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

      if (transactions.length > 0) {
        // Use new UNIQUE constraint: (source, payment_key)
        const { error: txError, data: txData } = await supabase
          .from("transactions")
          .upsert(transactions, { onConflict: "source,payment_key", ignoreDuplicates: false })
          .select("id");

        if (txError) {
          console.error(`Page ${pageCount + 1} tx error:`, txError.message);
        } else {
          totalSynced += txData?.length || 0;
        }
      }

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
    const origin = req.headers.get("origin");
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
