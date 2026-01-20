import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// SECURITY: Restricted CORS
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

interface ReconcileRequest {
  source: 'stripe' | 'paypal';
  start_date: string; // YYYY-MM-DD
  end_date: string;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
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

    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: ReconcileRequest = await req.json();
    const { source, start_date, end_date } = body;

    console.log(`[reconcile] Starting for ${source} from ${start_date} to ${end_date}`);

    let externalTotal = 0;
    let externalTransactions: string[] = [];

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
      // PayPal reconciliation would go here
      // For now, return a placeholder
      console.log('[reconcile] PayPal reconciliation not yet implemented');
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
