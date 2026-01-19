import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate sync secret (optional extra security layer)
    const syncSecret = req.headers.get('x-sync-secret');
    const expectedSecret = Deno.env.get('SYNC_SECRET');
    
    if (expectedSecret && syncSecret !== expectedSecret) {
      console.error('Invalid sync secret');
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { clients } = await req.json();

    if (!clients || !Array.isArray(clients)) {
      return new Response(
        JSON.stringify({ error: 'Invalid payload: clients array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📥 Received ${clients.length} clients to sync`);

    // Use service role to bypass RLS
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    // Validate and clean client data
    const validClients = clients
      .filter((c: any) => c.email && c.email.includes('@'))
      .map((c: any) => ({
        email: c.email?.trim().toLowerCase(),
        full_name: c.full_name?.trim() || null,
        phone: c.phone?.trim() || null,
        status: c.status || 'active',
        last_sync: new Date().toISOString(),
        // Preserve lifecycle_stage if client is already a CUSTOMER
        lifecycle_stage: c.lifecycle_stage || 'LEAD',
      }));

    if (validClients.length === 0) {
      return new Response(
        JSON.stringify({ success: true, inserted: 0, message: 'No valid clients to sync' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get existing clients to preserve their lifecycle_stage
    const emails = validClients.map((c: any) => c.email);
    const { data: existingClients } = await supabaseAdmin
      .from('clients')
      .select('email, lifecycle_stage, total_paid')
      .in('email', emails);

    const existingMap = new Map(
      (existingClients || []).map((c: any) => [c.email, c])
    );

    // Merge: preserve CUSTOMER status and total_paid
    const mergedClients = validClients.map((c: any) => {
      const existing = existingMap.get(c.email);
      if (existing) {
        return {
          ...c,
          // Never downgrade CUSTOMER to LEAD
          lifecycle_stage: existing.lifecycle_stage === 'CUSTOMER' ? 'CUSTOMER' : c.lifecycle_stage,
          // Preserve total_paid
          total_paid: existing.total_paid || 0,
        };
      }
      return c;
    });

    // Upsert in batches of 500
    const batchSize = 500;
    let totalInserted = 0;
    let totalUpdated = 0;

    for (let i = 0; i < mergedClients.length; i += batchSize) {
      const batch = mergedClients.slice(i, i + batchSize);
      
      const { data, error } = await supabaseAdmin
        .from('clients')
        .upsert(batch, { 
          onConflict: 'email',
          ignoreDuplicates: false 
        })
        .select('id');

      if (error) {
        console.error(`❌ Batch error at ${i}:`, error);
        throw error;
      }

      const batchCount = data?.length || 0;
      totalInserted += batchCount;
      console.log(`✅ Batch ${Math.floor(i / batchSize) + 1}: ${batchCount} records`);
    }

    console.log(`🎉 Sync complete: ${totalInserted} total records processed`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: mergedClients.length,
        message: `Synced ${mergedClients.length} clients successfully`
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
