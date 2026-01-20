import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
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

    const { clients } = await req.json();

    if (!clients || !Array.isArray(clients)) {
      return new Response(
        JSON.stringify({ error: 'Invalid payload: clients array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📥 Received ${clients.length} clients to sync`);

    const supabaseAdmin = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    const validClients = clients
      .filter((c: any) => c.email && c.email.includes('@'))
      .map((c: any) => ({
        email: c.email?.trim().toLowerCase(),
        full_name: c.full_name?.trim() || null,
        phone: c.phone?.trim() || null,
        status: c.status || 'active',
        last_sync: new Date().toISOString(),
        lifecycle_stage: c.lifecycle_stage || 'LEAD',
      }));

    if (validClients.length === 0) {
      return new Response(
        JSON.stringify({ success: true, inserted: 0, message: 'No valid clients to sync' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const emails = validClients.map((c: any) => c.email);
    const { data: existingClients } = await supabaseAdmin
      .from('clients')
      .select('email, lifecycle_stage, total_paid')
      .in('email', emails);

    const existingMap = new Map(
      (existingClients || []).map((c: any) => [c.email, c])
    );

    const mergedClients = validClients.map((c: any) => {
      const existing = existingMap.get(c.email);
      if (existing) {
        return {
          ...c,
          lifecycle_stage: existing.lifecycle_stage === 'CUSTOMER' ? 'CUSTOMER' : c.lifecycle_stage,
          total_paid: existing.total_paid || 0,
        };
      }
      return c;
    });

    const batchSize = 500;
    let totalInserted = 0;

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
    const origin = req.headers.get("origin");
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Sync error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...getCorsHeaders(origin), 'Content-Type': 'application/json' } }
    );
  }
});
