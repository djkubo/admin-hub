import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });

    // Authenticate via x-admin-key
    const adminKeyHeader = req.headers.get("x-admin-key");
    
    if (!adminKeyHeader) {
      return new Response(
        JSON.stringify({ error: "Missing x-admin-key header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: settingsData } = await supabaseAdmin
      .from('system_settings')
      .select('value')
      .eq('key', 'admin_api_key')
      .single();
    
    if (!settingsData?.value || adminKeyHeader !== settingsData.value) {
      console.error("❌ Invalid admin key");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Authenticated via x-admin-key");

    const { sales } = await req.json();

    if (!sales || !Array.isArray(sales)) {
      return new Response(
        JSON.stringify({ error: 'Invalid payload: sales array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📥 Received ${sales.length} web sales to sync`);

    // Process and validate sales
    const validSales = sales
      .filter((s: any) => s.email && s.email.includes('@') && s.amount !== undefined)
      .map((s: any) => {
        // Generate unique payment_key for deduplication
        const paymentKey = s.sale_id || s.id || `web_${s.email}_${s.purchase_date}`;
        
        // Parse amount - accept cents or dollars
        let amountCents = 0;
        if (typeof s.amount === 'number') {
          // If amount < 1000, assume dollars, convert to cents
          amountCents = s.amount < 1000 ? Math.round(s.amount * 100) : s.amount;
        } else if (typeof s.amount === 'string') {
          // Remove $ and parse
          const cleaned = s.amount.replace(/[$,]/g, '').trim();
          const parsed = parseFloat(cleaned);
          amountCents = parsed < 1000 ? Math.round(parsed * 100) : parsed;
        }

        return {
          stripe_payment_intent_id: `web_${paymentKey}`,
          payment_key: paymentKey,
          source: 'web',
          external_transaction_id: s.sale_id || s.id || null,
          customer_email: s.email?.trim().toLowerCase(),
          amount: amountCents,
          currency: (s.currency || 'usd').toLowerCase(),
          status: mapStatus(s.status || s.state || 'succeeded'),
          payment_type: mapPaymentType(s.plan_type || s.plan),
          stripe_created_at: s.purchase_date || s.created_at || new Date().toISOString(),
          metadata: {
            plan_name: s.plan_name || s.plan || null,
            payment_method: s.payment_method || null,
            phone: s.phone || null,
            full_name: s.full_name || s.name || null,
            original_source: 'web_sync',
          }
        };
      });

    if (validSales.length === 0) {
      return new Response(
        JSON.stringify({ success: true, inserted: 0, updated: 0, message: 'No valid sales to sync' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`✅ Validated ${validSales.length} sales`);

    // Upsert in batches
    const batchSize = 500;
    let totalInserted = 0;
    let totalUpdated = 0;
    const errors: string[] = [];

    for (let i = 0; i < validSales.length; i += batchSize) {
      const batch = validSales.slice(i, i + batchSize);
      
      const { data, error } = await supabaseAdmin
        .from('transactions')
        .upsert(batch, { 
          onConflict: 'source,payment_key',
          ignoreDuplicates: false 
        })
        .select('id');

      if (error) {
        console.error(`❌ Batch error at ${i}:`, error.message);
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
      } else {
        const batchCount = data?.length || 0;
        totalInserted += batchCount;
        console.log(`✅ Batch ${Math.floor(i / batchSize) + 1}: ${batchCount} records`);
      }
    }

    // Also sync/update clients table
    const clientUpdates = validSales
      .filter((s: any) => s.metadata?.full_name || s.metadata?.phone)
      .map((s: any) => ({
        email: s.customer_email,
        full_name: s.metadata.full_name || null,
        phone: s.metadata.phone || null,
        lifecycle_stage: 'CUSTOMER',
        last_sync: new Date().toISOString(),
      }));

    if (clientUpdates.length > 0) {
      const { error: clientError } = await supabaseAdmin
        .from('clients')
        .upsert(clientUpdates, { 
          onConflict: 'email',
          ignoreDuplicates: false 
        });

      if (clientError) {
        console.error("⚠️ Client update error:", clientError.message);
      } else {
        console.log(`👥 Updated ${clientUpdates.length} client records`);
      }
    }

    console.log(`🎉 Sync complete: ${totalInserted} sales processed`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: validSales.length,
        inserted: totalInserted,
        clients_updated: clientUpdates.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `Synced ${validSales.length} web sales successfully`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Sync error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Helper: Map status strings to our standard
function mapStatus(status: string): string {
  const s = status.toLowerCase();
  if (['active', 'completed', 'paid', 'succeeded', 'success'].includes(s)) return 'succeeded';
  if (['pastdue', 'past_due', 'overdue'].includes(s)) return 'requires_payment_method';
  if (['canceled', 'cancelled', 'expired'].includes(s)) return 'canceled';
  if (['failed', 'declined'].includes(s)) return 'failed';
  if (['pending', 'processing'].includes(s)) return 'pending';
  return 'succeeded';
}

// Helper: Determine payment type from plan info
function mapPaymentType(planInfo: string | null): string {
  if (!planInfo) return 'renewal';
  const p = planInfo.toLowerCase();
  if (p.includes('trial')) return 'trial_conversion';
  if (p.includes('anual') || p.includes('annual')) return 'renewal';
  if (p.includes('mensual') || p.includes('monthly')) return 'renewal';
  return 'renewal';
}
