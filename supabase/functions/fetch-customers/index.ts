import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============ VERIFY ADMIN ============
async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { valid: false, error: 'Invalid token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true, userId: user.id };
}

interface SyncRequest {
  limit?: number;
  cursor?: string;
  fetchAll?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // SECURITY: Verify JWT + is_admin()
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: authCheck.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      return new Response(
        JSON.stringify({ ok: false, error: 'STRIPE_SECRET_KEY not configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let body: SyncRequest = {};
    try {
      body = await req.json();
    } catch {
      // Empty body OK
    }

    const limit = Math.min(body.limit || 100, 100);
    const fetchAll = body.fetchAll ?? true;
    let startingAfter = body.cursor;
    let hasMore = true;
    let totalFetched = 0;
    let totalUpserted = 0;
    const maxPages = 50; // Max 5k customers per request
    let pageCount = 0;

    console.log(`[fetch-customers] Starting sync, fetchAll=${fetchAll}, limit=${limit}`);

    while (hasMore && pageCount < maxPages) {
      pageCount++;
      
      const params = new URLSearchParams({
        limit: limit.toString(),
        'expand[]': 'data.discount',
      });
      params.append('expand[]', 'data.sources');
      
      if (startingAfter) {
        params.set('starting_after', startingAfter);
      }

      const response = await fetch(`https://api.stripe.com/v1/customers?${params}`, {
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[fetch-customers] Stripe API error: ${response.status} - ${errorText}`);
        throw new Error(`Stripe API error: ${response.status}`);
      }

      const data = await response.json();
      const customers = data.data || [];
      totalFetched += customers.length;

      console.log(`[fetch-customers] Page ${pageCount}: fetched ${customers.length} customers`);

      const batch = customers.map((c: any) => ({
        stripe_customer_id: c.id,
        email: c.email,
        name: c.name,
        phone: c.phone,
        description: c.description,
        created_at_stripe: c.created ? new Date(c.created * 1000).toISOString() : null,
        currency: c.currency || 'usd',
        balance: c.balance || 0,
        delinquent: c.delinquent || false,
        default_source: c.default_source,
        invoice_prefix: c.invoice_prefix,
        metadata: c.metadata || {},
        tax_exempt: c.tax_exempt,
        address: c.address,
        shipping: c.shipping,
        discount: c.discount,
        synced_at: new Date().toISOString(),
      }));

      if (batch.length > 0) {
        const { error: upsertError } = await supabase
          .from('stripe_customers')
          .upsert(batch, { onConflict: 'stripe_customer_id' });

        if (upsertError) {
          console.error(`[fetch-customers] Upsert error:`, upsertError);
        } else {
          totalUpserted += batch.length;
        }
      }

      // Check if more pages - only continue if fetchAll is true
      hasMore = data.has_more && fetchAll;
      if (hasMore && customers.length > 0) {
        startingAfter = customers[customers.length - 1].id;
      } else {
        hasMore = false;
      }

      // Rate limit delay
      if (hasMore) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const duration = Date.now() - startTime;
    const responseHasMore = pageCount >= maxPages && hasMore;

    console.log(`[fetch-customers] Complete: ${totalFetched} fetched, ${totalUpserted} upserted in ${duration}ms`);

    return new Response(
      JSON.stringify({
        ok: true,
        status: responseHasMore ? 'continuing' : 'completed',
        processed: totalFetched,
        hasMore: responseHasMore,
        nextCursor: responseHasMore ? startingAfter : null,
        duration_ms: duration,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[fetch-customers] Error:', error);
    return new Response(
      JSON.stringify({ ok: false, status: 'error', error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
