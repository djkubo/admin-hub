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

// Map PayPal dispute status
function mapDisputeStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'OPEN': 'open',
    'WAITING_FOR_BUYER_RESPONSE': 'waiting_for_buyer',
    'WAITING_FOR_SELLER_RESPONSE': 'needs_response',
    'UNDER_REVIEW': 'under_review',
    'RESOLVED': 'resolved',
    'OTHER': 'other',
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

    // Parse request body for date filters
    let startDate: string | null = null;
    let endDate: string | null = null;
    
    try {
      const body = await req.json();
      startDate = body.startDate || null;
      endDate = body.endDate || null;
    } catch {
      // No body or invalid JSON, use defaults
    }

    // Default to last 180 days if no dates provided
    if (!startDate) {
      const start = new Date();
      start.setDate(start.getDate() - 180);
      startDate = start.toISOString();
    }
    if (!endDate) {
      endDate = new Date().toISOString();
    }

    console.log(`Fetching PayPal disputes from ${startDate} to ${endDate}`);
    const accessToken = await getPayPalAccessToken(paypalClientId, paypalClientSecret);

    // Create sync run record
    const { data: syncRun, error: syncRunError } = await supabase
      .from('sync_runs')
      .insert({
        source: 'paypal_disputes',
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (syncRunError) {
      console.error('Failed to create sync run:', syncRunError);
    }

    let allDisputes: any[] = [];
    let nextPageToken: string | null = null;

    // Fetch all disputes with pagination
    do {
      const params = new URLSearchParams({
        start_time: startDate,
        page_size: '50',
      });
      
      if (nextPageToken) {
        params.set('next_page_token', nextPageToken);
      }

      const url = `https://api-m.paypal.com/v1/customer/disputes?${params.toString()}`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log('No disputes found');
          break;
        }
        const error = await response.text();
        throw new Error(`PayPal API error: ${error}`);
      }

      const data = await response.json();
      const disputes = data.items || [];
      allDisputes = allDisputes.concat(disputes);

      console.log(`Fetched ${disputes.length} disputes`);

      // Check for next page
      const nextLink = data.links?.find((l: any) => l.rel === 'next');
      nextPageToken = nextLink ? new URL(nextLink.href).searchParams.get('next_page_token') : null;

    } while (nextPageToken);

    console.log(`Total disputes fetched: ${allDisputes.length}`);

    // Transform and upsert disputes
    const disputeBatch = allDisputes.map((dispute: any) => {
      const amount = dispute.dispute_amount?.value 
        ? Math.round(parseFloat(dispute.dispute_amount.value) * 100)
        : 0;

      return {
        external_dispute_id: dispute.dispute_id,
        source: 'paypal',
        status: mapDisputeStatus(dispute.status),
        reason: dispute.reason || null,
        amount: amount,
        currency: dispute.dispute_amount?.currency_code || 'USD',
        created_at_external: dispute.create_time || null,
        updated_at_external: dispute.update_time || null,
        customer_email: dispute.buyer?.email || null,
        customer_id: dispute.buyer?.payer_id || null,
        payment_intent_id: dispute.disputed_transactions?.[0]?.seller_transaction_id || null,
        charge_id: dispute.disputed_transactions?.[0]?.buyer_transaction_id || null,
        evidence_due_by: dispute.seller_response_due_date || null,
        has_evidence: dispute.offer?.history?.length > 0 || false,
        is_charge_refundable: dispute.dispute_life_cycle_stage !== 'CHARGEBACK',
        metadata: {
          dispute_channel: dispute.dispute_channel,
          dispute_life_cycle_stage: dispute.dispute_life_cycle_stage,
          messages: dispute.messages,
          extensions: dispute.extensions,
          links: dispute.links,
        },
        synced_at: new Date().toISOString(),
      };
    });

    let insertedCount = 0;
    if (disputeBatch.length > 0) {
      // Upsert in batches of 50
      for (let i = 0; i < disputeBatch.length; i += 50) {
        const batch = disputeBatch.slice(i, i + 50);
        const { error: upsertError, count } = await supabase
          .from('disputes')
          .upsert(batch, { 
            onConflict: 'external_dispute_id',
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
          total_fetched: allDisputes.length,
          total_inserted: insertedCount,
        })
        .eq('id', syncRun.id);
    }

    console.log(`Sync completed: ${allDisputes.length} fetched, ${insertedCount} upserted`);

    return new Response(
      JSON.stringify({
        success: true,
        fetched: allDisputes.length,
        upserted: insertedCount,
        syncRunId: syncRun?.id,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in fetch-paypal-disputes:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
