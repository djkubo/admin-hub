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

    let totalProducts = 0;
    let totalPrices = 0;

    console.log(`[fetch-products] Starting sync...`);

    // ========== FETCH PRODUCTS ==========
    let hasMore = true;
    let startingAfter: string | undefined;
    
    while (hasMore) {
      const params = new URLSearchParams({ limit: '100' });
      if (startingAfter) params.set('starting_after', startingAfter);

      const response = await fetch(`https://api.stripe.com/v1/products?${params}`, {
        headers: { 'Authorization': `Bearer ${stripeKey}` },
      });

      if (!response.ok) {
        throw new Error(`Stripe Products API error: ${response.status}`);
      }

      const data = await response.json();
      const products = data.data || [];

      const batch = products.map((p: any) => ({
        stripe_product_id: p.id,
        name: p.name,
        description: p.description,
        active: p.active,
        images: p.images || [],
        metadata: p.metadata || {},
        type: p.type,
        unit_label: p.unit_label,
        statement_descriptor: p.statement_descriptor,
        tax_code: p.tax_code,
        created_at_stripe: p.created ? new Date(p.created * 1000).toISOString() : null,
        updated_at_stripe: p.updated ? new Date(p.updated * 1000).toISOString() : null,
        synced_at: new Date().toISOString(),
      }));

      if (batch.length > 0) {
        const { error } = await supabase
          .from('stripe_products')
          .upsert(batch, { onConflict: 'stripe_product_id' });

        if (error) console.error(`[fetch-products] Products upsert error:`, error);
        else totalProducts += batch.length;
      }

      hasMore = data.has_more;
      if (hasMore && products.length > 0) {
        startingAfter = products[products.length - 1].id;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[fetch-products] Fetched ${totalProducts} products`);

    // ========== FETCH PRICES ==========
    hasMore = true;
    startingAfter = undefined;

    while (hasMore) {
      const params = new URLSearchParams({ limit: '100' });
      params.append('expand[]', 'data.product');
      if (startingAfter) params.set('starting_after', startingAfter);

      const response = await fetch(`https://api.stripe.com/v1/prices?${params}`, {
        headers: { 'Authorization': `Bearer ${stripeKey}` },
      });

      if (!response.ok) {
        throw new Error(`Stripe Prices API error: ${response.status}`);
      }

      const data = await response.json();
      const prices = data.data || [];

      const batch = prices.map((p: any) => ({
        stripe_price_id: p.id,
        stripe_product_id: typeof p.product === 'string' ? p.product : p.product?.id,
        active: p.active,
        currency: p.currency || 'usd',
        unit_amount: p.unit_amount,
        type: p.type,
        billing_scheme: p.billing_scheme,
        recurring_interval: p.recurring?.interval,
        recurring_interval_count: p.recurring?.interval_count || 1,
        recurring_usage_type: p.recurring?.usage_type,
        trial_period_days: p.recurring?.trial_period_days,
        nickname: p.nickname,
        metadata: p.metadata || {},
        lookup_key: p.lookup_key,
        tiers: p.tiers,
        transform_quantity: p.transform_quantity,
        created_at_stripe: p.created ? new Date(p.created * 1000).toISOString() : null,
        synced_at: new Date().toISOString(),
      }));

      if (batch.length > 0) {
        const { error } = await supabase
          .from('stripe_prices')
          .upsert(batch, { onConflict: 'stripe_price_id' });

        if (error) console.error(`[fetch-products] Prices upsert error:`, error);
        else totalPrices += batch.length;
      }

      hasMore = data.has_more;
      if (hasMore && prices.length > 0) {
        startingAfter = prices[prices.length - 1].id;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[fetch-products] Fetched ${totalPrices} prices`);

    const duration = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        ok: true,
        status: 'completed',
        processed: totalProducts + totalPrices,
        hasMore: false,
        duration_ms: duration,
        products: totalProducts,
        prices: totalPrices,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[fetch-products] Error:', error);
    return new Response(
      JSON.stringify({ ok: false, status: 'error', error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
