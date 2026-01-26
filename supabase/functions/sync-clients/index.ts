import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from '../_shared/logger.ts';

const logger = createLogger('sync-clients', LogLevel.INFO);

const ALLOWED_ORIGINS = [
  "https://id-preview--9d074359-befd-41d0-9307-39b75ab20410.lovable.app",
  "https://lovable.dev",
  "http://localhost:5173",
  "http://localhost:3000",
  "*", // Allow external scripts
];

function getCorsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.some(o => o === "*" || origin.startsWith(o.replace(/\/$/, '')))
    ? origin
    : "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret, x-admin-key",
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    // Create admin client for DB operations
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });

    // Check for x-admin-key authentication (for external scripts)
    const adminKeyHeader = req.headers.get("x-admin-key");
    const authHeader = req.headers.get("Authorization");

    let isAuthenticated = false;
    let authMethod = "";

    if (adminKeyHeader) {
      // Validate against stored admin key
      const { data: settingsData } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'admin_api_key')
        .single();

      if (settingsData?.value && adminKeyHeader === settingsData.value) {
        isAuthenticated = true;
        authMethod = "x-admin-key";
        console.log("✅ Authenticated via x-admin-key (external script)");
      }
    }

    // Fallback to JWT authentication
    if (!isAuthenticated && authHeader?.startsWith("Bearer ")) {
      const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } }
      });

      const token = authHeader.replace("Bearer ", "");
      const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getUser(token);

      if (!claimsError && claimsData?.user) {
        isAuthenticated = true;
        authMethod = "JWT";
        console.log("✅ Authenticated via JWT:", claimsData.user.email);
      }
    }

    if (!isAuthenticated) {
      console.error("❌ Authentication failed - no valid x-admin-key or JWT provided");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`🔐 Auth method: ${authMethod}`);

    const { clients } = await req.json();

    if (!clients || !Array.isArray(clients)) {
      return new Response(
        JSON.stringify({ error: 'Invalid payload: clients array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📥 Received ${clients.length} clients to sync`);

    // supabaseAdmin already created above

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

    // ============================================
    // POST-PROCESSING: Cross-reference with payments
    // ============================================
    console.log("🔄 Starting post-processing: cross-referencing with transactions...");

    // Get all synced emails
    const syncedEmails = mergedClients.map((c: any) => c.email);

    // Find first successful payment per email in transactions table
    const { data: paymentData, error: paymentError } = await supabaseAdmin
      .from('transactions')
      .select('customer_email, amount, status, stripe_created_at, payment_type')
      .in('customer_email', syncedEmails)
      .in('status', ['succeeded', 'paid'])
      .gt('amount', 0)
      .order('stripe_created_at', { ascending: true });

    if (paymentError) {
      console.error("⚠️ Error fetching payment data:", paymentError);
    }

    // Build payment map: email -> first payment info
    const paymentMap = new Map<string, {
      hasPaid: boolean;
      firstPaymentDate: string | null;
      totalPaid: number;
      paymentType: string | null;
    }>();

    for (const tx of (paymentData || [])) {
      const email = tx.customer_email?.toLowerCase();
      if (!email) continue;

      const existing = paymentMap.get(email);
      if (!existing) {
        paymentMap.set(email, {
          hasPaid: true,
          firstPaymentDate: tx.stripe_created_at,
          totalPaid: tx.amount || 0,
          paymentType: tx.payment_type
        });
      } else {
        // Sum up total paid
        paymentMap.set(email, {
          ...existing,
          totalPaid: existing.totalPaid + (tx.amount || 0)
        });
      }
    }

    // Update lifecycle_stage based on payment history
    let upgradedToCustomer = 0;
    let newLeads = 0;
    let alreadyCustomers = 0;

    for (const client of mergedClients) {
      const paymentInfo = paymentMap.get(client.email);
      const currentStage = client.lifecycle_stage;

      if (paymentInfo?.hasPaid) {
        // Has payment history -> should be CUSTOMER
        if (currentStage !== 'CUSTOMER') {
          const { error: updateError } = await supabaseAdmin
            .from('clients')
            .update({
              lifecycle_stage: 'CUSTOMER',
              first_payment_at: paymentInfo.firstPaymentDate,
              total_paid: paymentInfo.totalPaid
            })
            .eq('email', client.email);

          if (!updateError) {
            upgradedToCustomer++;
            console.log(`🎯 Upgraded to CUSTOMER: ${client.email} (paid: $${(paymentInfo.totalPaid / 100).toFixed(2)})`);
          }
        } else {
          alreadyCustomers++;
        }
      } else {
        // No payment history -> stays as LEAD
        newLeads++;
      }
    }

    console.log("📊 Post-processing results:");
    console.log(`   ✅ New LEADs (no payment yet): ${newLeads}`);
    console.log(`   🎯 Upgraded to CUSTOMER: ${upgradedToCustomer}`);
    console.log(`   👥 Already CUSTOMER: ${alreadyCustomers}`);

    // Build segmentation report
    const segmentationReport = {
      total_synced: mergedClients.length,
      new_leads: newLeads,
      upgraded_to_customer: upgradedToCustomer,
      already_customers: alreadyCustomers,
      leads_for_onboarding: newLeads,
      conversions_for_followup: upgradedToCustomer + alreadyCustomers
    };

    console.log(`🎉 Full sync complete with payment cross-reference`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: mergedClients.length,
        message: `Synced ${mergedClients.length} clients successfully`,
        segmentation: segmentationReport
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
