import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS: Allow all origins for production flexibility
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReconcileRequest {
  source: 'stripe' | 'paypal';
  start_date: string; // YYYY-MM-DD
  end_date: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
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

    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: ReconcileRequest = await req.json();
    const { source, start_date, end_date } = body;

    console.log(`[reconcile] Starting for ${source} from ${start_date} to ${end_date}`);

    let externalTotal = 0;
    const externalTransactions: string[] = [];

    if (source === 'stripe' && stripeKey) {
      // Fetch from Stripe API
      const startTimestamp = Math.floor(new Date(start_date).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(end_date + 'T23:59:59').getTime() / 1000);

      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const params = new URLSearchParams({
          'created[gte]': startTimestamp.toString(),
          'created[lte]': endTimestamp.toString(),
          'limit': '100',
          'status': 'succeeded'
        });

        if (startingAfter) {
          params.set('starting_after', startingAfter);
        }

        const response = await fetch(
          `https://api.stripe.com/v1/charges?${params}`,
          {
            headers: {
              'Authorization': `Bearer ${stripeKey}`,
            }
          }
        );

        if (!response.ok) {
          throw new Error(`Stripe API error: ${response.status}`);
        }

        const data = await response.json();
        
        for (const charge of data.data) {
          if (charge.status === 'succeeded' && !charge.refunded) {
            externalTotal += charge.amount;
            externalTransactions.push(charge.id);
          }
        }

        hasMore = data.has_more;
        if (data.data.length > 0) {
          startingAfter = data.data[data.data.length - 1].id;
        }
      }
    } else if (source === 'paypal') {
      const paypalClientId = Deno.env.get('PAYPAL_CLIENT_ID');
      const paypalSecret = Deno.env.get('PAYPAL_SECRET');
      
      if (!paypalClientId || !paypalSecret) {
        throw new Error('PayPal credentials not configured');
      }
      
      console.log('[reconcile] Starting PayPal reconciliation');
      
      // Get OAuth token
      const tokenRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${paypalClientId}:${paypalSecret}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });

      if (!tokenRes.ok) {
        throw new Error(`PayPal auth error: ${tokenRes.status}`);
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;
      
      // PayPal API requires ISO 8601 format with timezone
      const startDateISO = `${start_date}T00:00:00-0600`;
      const endDateISO = `${end_date}T23:59:59-0600`;
      
      let page = 1;
      let hasMorePages = true;
      
      while (hasMorePages) {
        const txRes = await fetch(
          `https://api-m.paypal.com/v1/reporting/transactions?` +
          `start_date=${encodeURIComponent(startDateISO)}&` +
          `end_date=${encodeURIComponent(endDateISO)}&` +
          `page_size=100&page=${page}&fields=all`,
          { 
            headers: { 
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            } 
          }
        );

        if (!txRes.ok) {
          const errText = await txRes.text();
          console.error('[reconcile] PayPal API error:', errText);
          throw new Error(`PayPal API error: ${txRes.status}`);
        }

        const txData = await txRes.json();
        
        for (const tx of txData.transaction_details || []) {
          const status = tx.transaction_info?.transaction_status;
          const eventCode = tx.transaction_info?.transaction_event_code;
          
          // S = Success, only count completed payments (T00xx = payments received)
          if (status === 'S' && eventCode?.startsWith('T00')) {
            const amountStr = tx.transaction_info?.transaction_amount?.value || '0';
            const amount = Math.round(parseFloat(amountStr) * 100); // Convert to cents
            
            if (amount > 0) {
              externalTotal += amount;
              externalTransactions.push(tx.transaction_info.transaction_id);
            }
          }
        }
        
        // Check for more pages
        const totalPages = txData.total_pages || 1;
        if (page >= totalPages) {
          hasMorePages = false;
        } else {
          page++;
        }
      }
      
      console.log(`[reconcile] PayPal fetched ${externalTransactions.length} transactions, total: ${externalTotal}`);
    }

    // Get internal totals
    const { data: internalData, error: internalError } = await supabase
      .from('transactions')
      .select('amount, stripe_payment_intent_id')
      .eq('source', source)
      .eq('status', 'succeeded')
      .gte('stripe_created_at', start_date)
      .lte('stripe_created_at', end_date + 'T23:59:59');

    if (internalError) {
      throw internalError;
    }

    const internalTotal = internalData?.reduce((sum, t) => sum + t.amount, 0) || 0;
    const internalIds = new Set(internalData?.map(t => t.stripe_payment_intent_id) || []);
    const externalIds = new Set(externalTransactions);

    // Find discrepancies
    const missingInternal = externalTransactions.filter(id => !internalIds.has(id));
    const missingExternal = Array.from(internalIds).filter(id => !externalIds.has(id as string));

    const difference = externalTotal - internalTotal;
    const differencePct = externalTotal > 0 
      ? Math.abs(difference / externalTotal * 100) 
      : 0;

    // Determine status
    let status = 'ok';
    if (differencePct > 5 || Math.abs(difference) > 10000) {
      status = 'fail';
    } else if (differencePct > 1 || Math.abs(difference) > 1000) {
      status = 'warning';
    }

    // Save reconciliation run
    const { data: runData, error: runError } = await supabase
      .from('reconciliation_runs')
      .insert({
        source,
        period_start: start_date,
        period_end: end_date,
        external_total: externalTotal,
        internal_total: internalTotal,
        difference,
        difference_pct: Math.round(differencePct * 100) / 100,
        status,
        missing_external: missingExternal.slice(0, 100),
        missing_internal: missingInternal.slice(0, 100)
      })
      .select()
      .single();

    if (runError) {
      console.error('[reconcile] Failed to save run:', runError);
    }

    console.log(`[reconcile] Completed: external=${externalTotal}, internal=${internalTotal}, diff=${difference}, status=${status}`);

    return new Response(
      JSON.stringify({
        success: true,
        reconciliation_id: runData?.id,
        source,
        period: { start: start_date, end: end_date },
        external_total: externalTotal,
        internal_total: internalTotal,
        difference,
        difference_pct: Math.round(differencePct * 100) / 100,
        status,
        missing_internal_count: missingInternal.length,
        missing_external_count: missingExternal.length
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[reconcile] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
