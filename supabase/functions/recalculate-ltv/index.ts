import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RecalculateRequest {
  batchSize?: number;
  dryRun?: boolean;
  startOffset?: number;
  clientEmail?: string; // For single-client recalculation
}

interface ProcessResult {
  processed: number;
  updated: number;
  skipped: number;
  lifecycleChanges: Record<string, number>;
  sampleUpdates: Array<{
    email: string;
    oldLtv: number;
    newLtv: number;
    oldLifecycle: string;
    newLifecycle: string;
  }>;
  hasMore: boolean;
  nextOffset: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: RecalculateRequest = await req.json().catch(() => ({}));
    const batchSize = Math.min(body.batchSize || 500, 1000);
    const dryRun = body.dryRun ?? false;
    const startOffset = body.startOffset || 0;
    const singleEmail = body.clientEmail?.toLowerCase().trim();

    console.log(`[recalculate-ltv] Starting batch: offset=${startOffset}, size=${batchSize}, dryRun=${dryRun}, singleEmail=${singleEmail || 'N/A'}`);

    const result: ProcessResult = {
      processed: 0,
      updated: 0,
      skipped: 0,
      lifecycleChanges: { LEAD: 0, TRIAL: 0, CUSTOMER: 0, CHURN: 0 },
      sampleUpdates: [],
      hasMore: false,
      nextOffset: startOffset,
    };

    // Fetch clients batch (or single client)
    let clientsQuery = supabase
      .from('clients')
      .select('id, email, total_spend, lifecycle_stage')
      .not('email', 'is', null);

    if (singleEmail) {
      clientsQuery = clientsQuery.eq('email', singleEmail);
    } else {
      clientsQuery = clientsQuery.range(startOffset, startOffset + batchSize - 1);
    }

    const { data: clients, error: clientsError } = await clientsQuery;

    if (clientsError) {
      console.error('[recalculate-ltv] Error fetching clients:', clientsError);
      throw new Error(`Failed to fetch clients: ${clientsError.message}`);
    }

    if (!clients || clients.length === 0) {
      console.log('[recalculate-ltv] No clients to process');
      return new Response(JSON.stringify({ success: true, result }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    result.hasMore = clients.length === batchSize;
    result.nextOffset = startOffset + clients.length;

    // Process each client
    for (const client of clients) {
      if (!client.email) {
        result.skipped++;
        continue;
      }

      result.processed++;
      const email = client.email.toLowerCase().trim();

      // 1. Calculate total LTV from ALL successful transactions
      const { data: txData, error: txError } = await supabase
        .from('transactions')
        .select('amount')
        .eq('customer_email', email)
        .in('status', ['succeeded', 'paid']);

      if (txError) {
        console.error(`[recalculate-ltv] Error fetching transactions for ${email}:`, txError);
        result.skipped++;
        continue;
      }

      const totalSpend = txData?.reduce((sum, tx) => sum + (tx.amount || 0), 0) || 0;
      const hasTransactions = txData && txData.length > 0;

      // 2. Check for active subscription
      const { data: activeSub, error: subError } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('customer_email', email)
        .in('status', ['active', 'trialing'])
        .limit(1);

      if (subError) {
        console.error(`[recalculate-ltv] Error fetching subscription for ${email}:`, subError);
      }

      // 3. Determine lifecycle stage
      let newLifecycle = 'LEAD';

      if (activeSub && activeSub.length > 0) {
        // Has active subscription
        newLifecycle = activeSub[0].status === 'trialing' ? 'TRIAL' : 'CUSTOMER';
      } else if (hasTransactions) {
        // No active sub, but has paid before - check recency
        const { data: lastTx } = await supabase
          .from('transactions')
          .select('stripe_created_at, created_at')
          .eq('customer_email', email)
          .in('status', ['succeeded', 'paid'])
          .order('stripe_created_at', { ascending: false, nullsFirst: false })
          .limit(1);

        if (lastTx && lastTx.length > 0) {
          const lastPaymentDate = new Date(lastTx[0].stripe_created_at || lastTx[0].created_at);
          const daysSinceLast = Math.floor((Date.now() - lastPaymentDate.getTime()) / (1000 * 60 * 60 * 24));
          
          // Grace period: 30 days after last payment still counts as CUSTOMER
          newLifecycle = daysSinceLast <= 30 ? 'CUSTOMER' : 'CHURN';
        } else {
          newLifecycle = 'CHURN';
        }
      }

      // Check if update is needed
      const oldLtv = client.total_spend || 0;
      const oldLifecycle = client.lifecycle_stage || 'LEAD';
      const needsUpdate = totalSpend !== oldLtv || newLifecycle !== oldLifecycle;

      if (needsUpdate) {
        // Track lifecycle changes
        result.lifecycleChanges[newLifecycle]++;

        // Sample first 10 updates for verification
        if (result.sampleUpdates.length < 10) {
          result.sampleUpdates.push({
            email: email,
            oldLtv: oldLtv / 100,
            newLtv: totalSpend / 100,
            oldLifecycle: oldLifecycle,
            newLifecycle: newLifecycle,
          });
        }

        if (!dryRun) {
          const { error: updateError } = await supabase
            .from('clients')
            .update({
              total_spend: totalSpend,
              lifecycle_stage: newLifecycle,
              last_sync: new Date().toISOString(),
            })
            .eq('id', client.id);

          if (updateError) {
            console.error(`[recalculate-ltv] Error updating client ${email}:`, updateError);
            result.skipped++;
            continue;
          }
        }

        result.updated++;
      }
    }

    console.log(`[recalculate-ltv] Batch complete: processed=${result.processed}, updated=${result.updated}, skipped=${result.skipped}`);
    console.log(`[recalculate-ltv] Lifecycle distribution:`, result.lifecycleChanges);

    return new Response(JSON.stringify({
      success: true,
      dryRun,
      result,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[recalculate-ltv] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
