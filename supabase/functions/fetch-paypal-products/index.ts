import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

// Verify admin API key
async function verifyAdminKey(req: Request, supabase: any): Promise<boolean> {
  const adminKey = req.headers.get('x-admin-key');
  if (!adminKey) return false;
  
  const { data } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'admin_api_key')
    .single();
  
  return data?.value === adminKey;
}

// Get PayPal access token
async function getPayPalAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const auth = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PayPal auth failed: ${error}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify admin key
    const isAdmin = await verifyAdminKey(req, supabase);
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const paypalClientId = Deno.env.get('PAYPAL_CLIENT_ID');
    const paypalClientSecret = Deno.env.get('PAYPAL_CLIENT_SECRET');

    if (!paypalClientId || !paypalClientSecret) {
      return new Response(
        JSON.stringify({ error: 'PayPal credentials not configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Getting PayPal access token...');
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalClientSecret);

    // Create sync run record
    const { data: syncRun, error: syncRunError } = await supabase
      .from('sync_runs')
      .insert({
        source: 'paypal_products',
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (syncRunError) {
      console.error('Failed to create sync run:', syncRunError);
    }

    let allProducts: any[] = [];
    let allPlans: any[] = [];
    let page = 1;
    let hasMore = true;

    // Fetch all products
    console.log('Fetching PayPal products...');
    while (hasMore) {
      const url = `https://api-m.paypal.com/v1/catalogs/products?page=${page}&page_size=20&total_required=true`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log('No products found');
          break;
        }
        const error = await response.text();
        throw new Error(`PayPal products API error: ${error}`);
      }

      const data = await response.json();
      const products = data.products || [];
      allProducts = allProducts.concat(products);

      console.log(`Fetched page ${page}: ${products.length} products`);

      hasMore = products.length === 20;
      page++;

      if (page > 50) break; // Safety limit
    }

    // Fetch billing plans
    console.log('Fetching PayPal billing plans...');
    page = 1;
    hasMore = true;

    while (hasMore) {
      const url = `https://api-m.paypal.com/v1/billing/plans?page=${page}&page_size=20&total_required=true`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log('No plans found');
          break;
        }
        const error = await response.text();
        throw new Error(`PayPal plans API error: ${error}`);
      }

      const data = await response.json();
      const plans = data.plans || [];
      allPlans = allPlans.concat(plans);

      console.log(`Fetched page ${page}: ${plans.length} plans`);

      hasMore = plans.length === 20;
      page++;

      if (page > 50) break;
    }

    console.log(`Total: ${allProducts.length} products, ${allPlans.length} plans`);

    // Transform products to stripe_products format
    const productBatch = allProducts.map((product: any) => ({
      stripe_product_id: `paypal_${product.id}`,
      name: product.name,
      description: product.description || null,
      active: product.status === 'ACTIVE',
      type: product.type || 'service',
      created_at_stripe: product.create_time || null,
      updated_at_stripe: product.update_time || null,
      metadata: {
        paypal_id: product.id,
        category: product.category,
        image_url: product.image_url,
        home_url: product.home_url,
      },
      synced_at: new Date().toISOString(),
    }));

    // Transform plans to stripe_prices format
    const priceBatch = allPlans.map((plan: any) => {
      const billingCycle = plan.billing_cycles?.[0];
      const pricing = billingCycle?.pricing_scheme;
      const frequency = billingCycle?.frequency;

      return {
        stripe_price_id: `paypal_${plan.id}`,
        stripe_product_id: plan.product_id ? `paypal_${plan.product_id}` : null,
        active: plan.status === 'ACTIVE',
        currency: pricing?.fixed_price?.currency_code?.toLowerCase() || 'usd',
        unit_amount: pricing?.fixed_price?.value 
          ? Math.round(parseFloat(pricing.fixed_price.value) * 100) 
          : null,
        type: 'recurring',
        recurring_interval: frequency?.interval_unit?.toLowerCase() || 'month',
        recurring_interval_count: frequency?.interval_count || 1,
        nickname: plan.name || null,
        created_at_stripe: plan.create_time || null,
        metadata: {
          paypal_plan_id: plan.id,
          description: plan.description,
          billing_cycles: plan.billing_cycles,
          payment_preferences: plan.payment_preferences,
          taxes: plan.taxes,
        },
        synced_at: new Date().toISOString(),
      };
    });

    let productsInserted = 0;
    let pricesInserted = 0;

    // Upsert products
    if (productBatch.length > 0) {
      for (let i = 0; i < productBatch.length; i += 50) {
        const batch = productBatch.slice(i, i + 50);
        const { error, count } = await supabase
          .from('stripe_products')
          .upsert(batch, { 
            onConflict: 'stripe_product_id',
            count: 'exact'
          });

        if (error) {
          console.error('Product upsert error:', error);
        } else {
          productsInserted += count || batch.length;
        }
      }
    }

    // Upsert prices/plans
    if (priceBatch.length > 0) {
      for (let i = 0; i < priceBatch.length; i += 50) {
        const batch = priceBatch.slice(i, i + 50);
        const { error, count } = await supabase
          .from('stripe_prices')
          .upsert(batch, { 
            onConflict: 'stripe_price_id',
            count: 'exact'
          });

        if (error) {
          console.error('Price upsert error:', error);
        } else {
          pricesInserted += count || batch.length;
        }
      }
    }

    // Update sync run
    if (syncRun) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          total_fetched: allProducts.length + allPlans.length,
          total_inserted: productsInserted + pricesInserted,
          metadata: {
            products_fetched: allProducts.length,
            plans_fetched: allPlans.length,
            products_inserted: productsInserted,
            prices_inserted: pricesInserted,
          }
        })
        .eq('id', syncRun.id);
    }

    console.log(`Sync completed: ${productsInserted} products, ${pricesInserted} plans upserted`);

    return new Response(
      JSON.stringify({
        success: true,
        products: {
          fetched: allProducts.length,
          upserted: productsInserted,
        },
        plans: {
          fetched: allPlans.length,
          upserted: pricesInserted,
        },
        syncRunId: syncRun?.id,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in fetch-paypal-products:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
