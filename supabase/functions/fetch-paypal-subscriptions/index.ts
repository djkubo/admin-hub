import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// SECURITY: JWT-based admin verification
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

// Map PayPal subscription status to Stripe-compatible status
function mapPayPalStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'APPROVAL_PENDING': 'incomplete',
    'APPROVED': 'incomplete',
    'ACTIVE': 'active',
    'SUSPENDED': 'paused',
    'CANCELLED': 'canceled',
    'EXPIRED': 'canceled',
  };
  return statusMap[status] || status.toLowerCase();
}

// Classify plan by amount/interval (consistent with Stripe logic)
function classifyPlan(amount: number, interval: string, productName: string | null): string {
  const amountUSD = amount / 100;
  
  if (interval === 'YEAR' || interval === 'year') {
    if (amountUSD >= 180 && amountUSD <= 220) return 'Plan Anual ~$195';
    if (amountUSD >= 350 && amountUSD <= 450) return 'Plan Anual Premium ~$400';
    return `Plan Anual $${Math.round(amountUSD)}`;
  }
  
  if (interval === 'MONTH' || interval === 'month') {
    if (amountUSD >= 30 && amountUSD <= 40) return 'Plan Mensual ~$35';
    if (amountUSD >= 45 && amountUSD <= 55) return 'Plan Mensual ~$50';
    if (amountUSD >= 95 && amountUSD <= 105) return 'Plan Mensual ~$100';
    return `Plan Mensual $${Math.round(amountUSD)}`;
  }
  
  if (productName) return productName;
  return `PayPal Plan $${Math.round(amountUSD)}`;
}

// Map PayPal interval to Stripe interval
function mapInterval(paypalInterval: string | undefined): string {
  const intervalMap: Record<string, string> = {
    'DAY': 'day',
    'WEEK': 'week',
    'MONTH': 'month',
    'YEAR': 'year',
  };
  return intervalMap[paypalInterval || ''] || 'month';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify admin
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const paypalClientId = Deno.env.get('PAYPAL_CLIENT_ID');
    const paypalClientSecret = Deno.env.get('PAYPAL_SECRET') || Deno.env.get('PAYPAL_CLIENT_SECRET');

    if (!paypalClientId || !paypalClientSecret) {
      const missing = [
        !paypalClientId && 'PAYPAL_CLIENT_ID',
        !paypalClientSecret && 'PAYPAL_SECRET',
      ].filter(Boolean);
      console.error('❌ Missing PayPal secrets:', missing.join(', '));
      return new Response(
        JSON.stringify({ 
          error: 'PayPal credentials not configured',
          message: `Missing secrets: ${missing.join(', ')}. Configure them in Lovable Cloud settings.`,
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('🔑 Getting PayPal access token...');
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

    let page = 1;
    let hasMore = true;
    const pageSize = 20;
    let totalFetched = 0;
    let totalUpserted = 0;
    const BATCH_SIZE = 50;
    let batch: any[] = [];

    console.log('📦 Fetching PayPal subscriptions...');

    // Fetch and process in streaming fashion
    while (hasMore) {
      const url = `https://api-m.paypal.com/v1/billing/subscriptions?page=${page}&page_size=${pageSize}&total_required=true`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
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
      totalFetched += subscriptions.length;

      console.log(`📄 Page ${page}: ${subscriptions.length} subscriptions (total: ${totalFetched})`);

      // Transform to unified subscriptions format
      for (const sub of subscriptions) {
        // Get billing amount from billing_info or plan
        const lastPayment = sub.billing_info?.last_payment?.amount;
        const amount = lastPayment?.value 
          ? Math.round(parseFloat(lastPayment.value) * 100)
          : 0;
        
        const interval = sub.billing_info?.cycle_executions?.[0]?.tenure_type || 
                        sub.plan?.billing_cycles?.[0]?.frequency?.interval_unit || 
                        'MONTH';
        
        const planName = classifyPlan(amount, interval, sub.plan?.name || null);
        
        batch.push({
          stripe_subscription_id: sub.id, // PayPal subscription ID (e.g., 'I-12345')
          stripe_customer_id: sub.subscriber?.payer_id || null,
          customer_email: sub.subscriber?.email_address || null,
          plan_name: planName,
          plan_id: sub.plan_id || null,
          amount: amount,
          currency: (lastPayment?.currency_code || 'USD').toLowerCase(),
          interval: mapInterval(interval),
          status: mapPayPalStatus(sub.status),
          provider: 'paypal',
          trial_start: null,
          trial_end: null,
          current_period_start: sub.start_time ? new Date(sub.start_time).toISOString() : null,
          current_period_end: sub.billing_info?.next_billing_time 
            ? new Date(sub.billing_info.next_billing_time).toISOString() 
            : null,
          canceled_at: sub.status === 'CANCELLED' && sub.update_time 
            ? new Date(sub.update_time).toISOString() 
            : null,
          cancel_reason: null,
          updated_at: new Date().toISOString(),
          raw_data: {
            paypal_subscription_id: sub.id,
            payer_name: sub.subscriber?.name 
              ? `${sub.subscriber.name.given_name || ''} ${sub.subscriber.name.surname || ''}`.trim() 
              : null,
            billing_info: sub.billing_info,
            create_time: sub.create_time,
          },
        });

        // Flush batch when full
        if (batch.length >= BATCH_SIZE) {
          const { error: upsertError } = await supabase
            .from('subscriptions')
            .upsert(batch, { onConflict: 'stripe_subscription_id' });

          if (upsertError) {
            console.error('❌ Batch upsert error:', upsertError);
          } else {
            totalUpserted += batch.length;
            console.log(`✅ Upserted batch: ${totalUpserted} total`);
          }
          batch = []; // Clear memory
        }
      }

      // Check if there are more pages
      hasMore = subscriptions.length === pageSize;
      page++;

      // Safety limit
      if (page > 100) {
        console.log('⚠️ Reached pagination limit');
        break;
      }

      // Update progress
      if (syncRun) {
        await supabase.from('sync_runs').update({
          total_fetched: totalFetched,
          total_inserted: totalUpserted,
        }).eq('id', syncRun.id);
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      const { error: upsertError } = await supabase
        .from('subscriptions')
        .upsert(batch, { onConflict: 'stripe_subscription_id' });

      if (upsertError) {
        console.error('❌ Final batch upsert error:', upsertError);
      } else {
        totalUpserted += batch.length;
      }
    }

    // Update sync run
    if (syncRun) {
      await supabase.from('sync_runs').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalUpserted,
      }).eq('id', syncRun.id);
    }

    console.log(`✅ PayPal sync completed: ${totalFetched} fetched, ${totalUpserted} upserted to unified subscriptions table`);

    return new Response(
      JSON.stringify({
        success: true,
        fetched: totalFetched,
        upserted: totalUpserted,
        syncRunId: syncRun?.id,
        message: 'PayPal subscriptions synced to unified subscriptions table',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('❌ Error in fetch-paypal-subscriptions:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
