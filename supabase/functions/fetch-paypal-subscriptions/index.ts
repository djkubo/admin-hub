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

// Map PayPal subscription status to our internal status
function mapPayPalStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'APPROVAL_PENDING': 'pending',
    'APPROVED': 'approved',
    'ACTIVE': 'active',
    'SUSPENDED': 'paused',
    'CANCELLED': 'canceled',
    'EXPIRED': 'expired',
  };
  return statusMap[status] || status.toLowerCase();
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
        source: 'paypal_subscriptions',
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (syncRunError) {
      console.error('Failed to create sync run:', syncRunError);
    }

    let allSubscriptions: any[] = [];
    let page = 1;
    let hasMore = true;
    const pageSize = 20;

    console.log('Fetching PayPal subscriptions...');

    // Fetch all subscriptions with pagination
    while (hasMore) {
      const url = `https://api-m.paypal.com/v1/billing/subscriptions?page=${page}&page_size=${pageSize}&total_required=true`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // PayPal returns 404 when no subscriptions exist
        if (response.status === 404) {
          console.log('No subscriptions found in PayPal');
          hasMore = false;
          break;
        }
        const error = await response.text();
        throw new Error(`PayPal API error: ${error}`);
      }

      const data = await response.json();
      const subscriptions = data.subscriptions || [];
      allSubscriptions = allSubscriptions.concat(subscriptions);

      console.log(`Fetched page ${page}: ${subscriptions.length} subscriptions`);

      // Check if there are more pages
      hasMore = subscriptions.length === pageSize;
      page++;

      // Safety limit
      if (page > 100) {
        console.log('Reached pagination limit');
        break;
      }
    }

    console.log(`Total subscriptions fetched: ${allSubscriptions.length}`);

    // Transform and upsert subscriptions
    const subscriptionBatch = allSubscriptions.map((sub: any) => ({
      paypal_subscription_id: sub.id,
      status: mapPayPalStatus(sub.status),
      plan_id: sub.plan_id,
      plan_name: sub.plan?.name || null,
      payer_id: sub.subscriber?.payer_id || null,
      payer_email: sub.subscriber?.email_address || null,
      payer_name: sub.subscriber?.name ? 
        `${sub.subscriber.name.given_name || ''} ${sub.subscriber.name.surname || ''}`.trim() : null,
      start_time: sub.start_time || null,
      create_time: sub.create_time || null,
      update_time: sub.update_time || null,
      billing_info: sub.billing_info || null,
      subscriber: sub.subscriber || null,
      auto_renewal: sub.auto_renewal ?? true,
      quantity: sub.quantity || 1,
      shipping_amount: sub.shipping_amount?.value ? 
        Math.round(parseFloat(sub.shipping_amount.value) * 100) : null,
      tax_amount: sub.billing_info?.last_payment?.amount?.value ?
        null : null, // PayPal doesn't separate tax in subscription
      metadata: {
        custom_id: sub.custom_id,
        links: sub.links,
      },
      synced_at: new Date().toISOString(),
    }));

    let insertedCount = 0;
    if (subscriptionBatch.length > 0) {
      // Upsert in batches of 50
      for (let i = 0; i < subscriptionBatch.length; i += 50) {
        const batch = subscriptionBatch.slice(i, i + 50);
        const { error: upsertError, count } = await supabase
          .from('paypal_subscriptions')
          .upsert(batch, { 
            onConflict: 'paypal_subscription_id',
            count: 'exact'
          });

        if (upsertError) {
          console.error('Upsert error:', upsertError);
        } else {
          insertedCount += count || batch.length;
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
          total_fetched: allSubscriptions.length,
          total_inserted: insertedCount,
        })
        .eq('id', syncRun.id);
    }

    console.log(`Sync completed: ${allSubscriptions.length} fetched, ${insertedCount} upserted`);

    return new Response(
      JSON.stringify({
        success: true,
        fetched: allSubscriptions.length,
        upserted: insertedCount,
        syncRunId: syncRun?.id,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in fetch-paypal-subscriptions:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
