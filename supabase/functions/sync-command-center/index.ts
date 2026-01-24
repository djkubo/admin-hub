// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SyncConfig {
  mode: 'today' | '7d' | 'month' | 'full';
  startDate?: string;
  endDate?: string;
  includeContacts?: boolean;
}

// Response types for sub-function invocations
interface StripeSyncResponse {
  success: boolean;
  error?: string;
  synced_transactions?: number;
  syncRunId?: string;
  nextCursor?: string;
  hasMore?: boolean;
}

interface GenericSyncResponse {
  success: boolean;
  error?: string;
  synced?: number;
  upserted?: number;
  unified?: number;
}

interface PayPalSyncResponse {
  success: boolean;
  error?: string;
  synced_transactions?: number;
  syncRunId?: string;
  nextPage?: number;
  hasMore?: boolean;
}

// SECURITY: JWT-based admin verification using getUser()
async function verifyAdmin(
  supabase: any
): Promise<{ valid: boolean; error?: string; email?: string }> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  
  if (userError || !user) {
    return { valid: false, error: 'Invalid or expired token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  
  if (adminError || !isAdmin) {
    return { valid: false, error: 'User is not an admin' };
  }

  return { valid: true, email: user.email };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  
  try {
    // ============ AUTHENTICATION ============
    const authHeader = req.headers.get("Authorization");
    
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing or invalid Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client for auth verification - uses anon key with user's JWT
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    
    const authCheck = await verifyAdmin(authClient);
    
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ success: false, error: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userEmail = authCheck.email || "";
    console.log("✅ Admin authenticated:", userEmail);

    // ============ SEPARATE CLIENTS ============
    // dbClient: For direct database operations (uses service role)
    const dbClient = createClient(supabaseUrl, serviceRoleKey);
    
    // invokeClient: For invoking sub-functions (uses anon key + user's JWT)
    // This ensures sub-functions receive the original JWT for their own auth checks
    const invokeClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // ============ PARSE CONFIG ============
    let config: SyncConfig = { mode: 'today' };
    try {
      const body = await req.json();
      config = {
        mode: body.mode || 'today',
        startDate: body.startDate,
        endDate: body.endDate,
        includeContacts: body.includeContacts || false,
      };
    } catch {
      // Use defaults
    }

    // Calculate date range based on mode
    const now = new Date();
    let startDate: Date;
    let endDate = now;
    
    switch (config.mode) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'full':
        startDate = new Date(now.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);
        break;
    }

    if (config.startDate) startDate = new Date(config.startDate);
    if (config.endDate) endDate = new Date(config.endDate);

    // ============ CREATE MASTER SYNC RUN ============
    const { data: syncRun, error: syncRunError } = await dbClient
      .from("sync_runs")
      .insert({
        source: "command-center",
        status: "running",
        metadata: {
          mode: config.mode,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          authMethod: "jwt+is_admin",
          userEmail,
          steps: [],
        }
      })
      .select()
      .single();

    if (syncRunError) {
      throw new Error(`Failed to create sync run: ${syncRunError.message}`);
    }

    const syncRunId = syncRun.id;
    console.log(`📊 Master sync run created: ${syncRunId}`);

    // Helper to update progress
    const updateProgress = async (step: string, details: string, counts?: { fetched?: number; inserted?: number }) => {
      const metadata = syncRun.metadata as Record<string, unknown> || {};
      const steps = (metadata.steps as string[]) || [];
      steps.push(`${step}: ${details}`);
      
      await dbClient
        .from("sync_runs")
        .update({
          metadata: { ...metadata, steps, currentStep: step, lastUpdate: new Date().toISOString() },
          checkpoint: { step, details, timestamp: new Date().toISOString() },
          ...(counts?.fetched && { total_fetched: (syncRun.total_fetched || 0) + counts.fetched }),
          ...(counts?.inserted && { total_inserted: (syncRun.total_inserted || 0) + counts.inserted }),
        })
        .eq("id", syncRunId);
    };

    // Helper to format dates for PayPal (no milliseconds)
    const formatPayPalDate = (date: Date): string => {
      return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    };

    const results: Record<string, { success: boolean; count: number; error?: string }> = {};

    // ============ STRIPE SYNC ============
    try {
      await updateProgress("stripe-transactions", "Iniciando...");
      let totalStripe = 0;
      let hasMore = true;
      let cursor: string | null = null;
      let stripeSyncId: string | null = null;
      
      while (hasMore) {
        const response = await invokeClient.functions.invoke('fetch-stripe', {
          body: {
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            cursor,
            syncRunId: stripeSyncId,
          }
        });
        
        const stripeResp = response.data as StripeSyncResponse | null;
        if (response.error) throw response.error;
        if (stripeResp?.error === 'sync_already_running') {
          results["stripe"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        totalStripe += stripeResp?.synced_transactions || 0;
        stripeSyncId = stripeResp?.syncRunId || stripeSyncId;
        cursor = stripeResp?.nextCursor || null;
        hasMore = stripeResp?.hasMore === true && cursor !== null;
        
        await updateProgress("stripe-transactions", `${totalStripe} transacciones`);
      }
      if (!results["stripe"]) {
        results["stripe"] = { success: true, count: totalStripe };
      }
    } catch (e) {
      console.error("Stripe sync error:", e);
      results["stripe"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE SUBSCRIPTIONS ============
    try {
      await updateProgress("stripe-subscriptions", "Iniciando...");
      const { data: subsData, error: subsError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-subscriptions');
      if (subsError) throw subsError;
      results["subscriptions"] = { success: true, count: subsData?.synced || subsData?.upserted || 0 };
      await updateProgress("stripe-subscriptions", `${results["subscriptions"].count} suscripciones`);
    } catch (e) {
      console.error("Subscriptions sync error:", e);
      results["subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE INVOICES ============
    try {
      await updateProgress("stripe-invoices", "Iniciando...");
      const { data: invData, error: invError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-invoices');
      if (invError) throw invError;
      results["invoices"] = { success: true, count: invData?.synced || 0 };
      await updateProgress("stripe-invoices", `${results["invoices"].count} facturas`);
    } catch (e) {
      console.error("Invoices sync error:", e);
      results["invoices"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE CUSTOMERS ============
    try {
      await updateProgress("stripe-customers", "Iniciando...");
      const { data: custData, error: custError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-customers');
      if (custError) throw custError;
      results["customers"] = { success: true, count: custData?.synced || 0 };
      await updateProgress("stripe-customers", `${results["customers"].count} clientes`);
    } catch (e) {
      console.error("Customers sync error:", e);
      results["customers"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE PRODUCTS ============
    try {
      await updateProgress("stripe-products", "Iniciando...");
      const { data: prodData, error: prodError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-products');
      if (prodError) throw prodError;
      results["products"] = { success: true, count: prodData?.synced || 0 };
      await updateProgress("stripe-products", `${results["products"].count} productos`);
    } catch (e) {
      console.error("Products sync error:", e);
      results["products"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE DISPUTES ============
    try {
      await updateProgress("stripe-disputes", "Iniciando...");
      const { data: dispData, error: dispError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-disputes');
      if (dispError) throw dispError;
      results["disputes"] = { success: true, count: dispData?.synced || 0 };
      await updateProgress("stripe-disputes", `${results["disputes"].count} disputas`);
    } catch (e) {
      console.error("Disputes sync error:", e);
      results["disputes"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE PAYOUTS ============
    try {
      await updateProgress("stripe-payouts", "Iniciando...");
      const { data: payoutsData, error: payoutsError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-payouts');
      if (payoutsError) throw payoutsError;
      results["payouts"] = { success: true, count: payoutsData?.synced || 0 };
      await updateProgress("stripe-payouts", `${results["payouts"].count} payouts`);
    } catch (e) {
      console.error("Payouts sync error:", e);
      results["payouts"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE BALANCE ============
    try {
      await updateProgress("stripe-balance", "Iniciando...");
      const { error: balError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-balance');
      if (balError) throw balError;
      results["balance"] = { success: true, count: 1 };
      await updateProgress("stripe-balance", "Balance actualizado");
    } catch (e) {
      console.error("Balance sync error:", e);
      results["balance"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL TRANSACTIONS ============
    try {
      await updateProgress("paypal-transactions", "Iniciando...");
      let totalPaypal = 0;
      let hasMore = true;
      let page = 1;
      let paypalSyncId: string | null = null;
      
      while (hasMore && page <= 100) {
        const ppResponse = await invokeClient.functions.invoke('fetch-paypal', {
          body: {
            fetchAll: true,
            startDate: formatPayPalDate(startDate),
            endDate: formatPayPalDate(endDate),
            page,
            syncRunId: paypalSyncId,
          }
        });
        
        const ppResp = ppResponse.data as PayPalSyncResponse | null;
        if (ppResponse.error) throw ppResponse.error;
        if (ppResp?.error === 'sync_already_running') {
          results["paypal"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        totalPaypal += ppResp?.synced_transactions || 0;
        paypalSyncId = ppResp?.syncRunId || paypalSyncId;
        hasMore = ppResp?.hasMore === true;
        page = ppResp?.nextPage || page + 1;
        
        await updateProgress("paypal-transactions", `${totalPaypal} transacciones`);
      }
      if (!results["paypal"]) {
        results["paypal"] = { success: true, count: totalPaypal };
      }
    } catch (e) {
      console.error("PayPal sync error:", e);
      results["paypal"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL SUBSCRIPTIONS ============
    try {
      await updateProgress("paypal-subscriptions", "Iniciando...");
      const { data: ppSubsData, error: ppSubsError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-paypal-subscriptions');
      if (ppSubsError) throw ppSubsError;
      results["paypal-subscriptions"] = { success: true, count: ppSubsData?.synced || 0 };
      await updateProgress("paypal-subscriptions", `${results["paypal-subscriptions"].count} suscripciones`);
    } catch (e) {
      console.error("PayPal subscriptions sync error:", e);
      results["paypal-subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL DISPUTES ============
    try {
      await updateProgress("paypal-disputes", "Iniciando...");
      const { data: ppDispData, error: ppDispError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-paypal-disputes');
      if (ppDispError) throw ppDispError;
      results["paypal-disputes"] = { success: true, count: ppDispData?.synced || 0 };
      await updateProgress("paypal-disputes", `${results["paypal-disputes"].count} disputas`);
    } catch (e) {
      console.error("PayPal disputes sync error:", e);
      results["paypal-disputes"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL PRODUCTS ============
    try {
      await updateProgress("paypal-products", "Iniciando...");
      const { data: ppProdData, error: ppProdError } = await invokeClient.functions.invoke<GenericSyncResponse>('fetch-paypal-products');
      if (ppProdError) throw ppProdError;
      results["paypal-products"] = { success: true, count: ppProdData?.synced || 0 };
      await updateProgress("paypal-products", `${results["paypal-products"].count} productos`);
    } catch (e) {
      console.error("PayPal products sync error:", e);
      results["paypal-products"] = { success: false, count: 0, error: String(e) };
    }

    // ============ CONTACTS (OPTIONAL) ============
    if (config.includeContacts) {
      // GHL
      try {
        await updateProgress("ghl-contacts", "Iniciando...");
        const { data: ghlData, error: ghlError } = await invokeClient.functions.invoke<GenericSyncResponse>('sync-ghl');
        if (ghlError) throw ghlError;
        results["ghl"] = { success: true, count: ghlData?.synced || 0 };
        await updateProgress("ghl-contacts", `${results["ghl"].count} contactos`);
      } catch (e) {
        console.error("GHL sync error:", e);
        results["ghl"] = { success: false, count: 0, error: String(e) };
      }

      // ManyChat
      try {
        await updateProgress("manychat-contacts", "Iniciando...");
        const { data: mcData, error: mcError } = await invokeClient.functions.invoke<GenericSyncResponse>('sync-manychat');
        if (mcError) throw mcError;
        results["manychat"] = { success: true, count: mcData?.synced || 0 };
        await updateProgress("manychat-contacts", `${results["manychat"].count} contactos`);
      } catch (e) {
        console.error("ManyChat sync error:", e);
        results["manychat"] = { success: false, count: 0, error: String(e) };
      }

      // Unify identities
      try {
        await updateProgress("unify-identity", "Iniciando...");
        const { data: unifyData, error: unifyError } = await invokeClient.functions.invoke<GenericSyncResponse>('unify-identity');
        if (unifyError) throw unifyError;
        results["unify"] = { success: true, count: unifyData?.unified || 0 };
        await updateProgress("unify-identity", `${results["unify"].count} identidades unificadas`);
      } catch (e) {
        console.error("Unify identity error:", e);
        results["unify"] = { success: false, count: 0, error: String(e) };
      }
    }

    // ============ COMPLETE SYNC RUN ============
    const totalFetched = Object.values(results).reduce((sum, r) => sum + r.count, 0);
    const failedSteps = Object.entries(results).filter(([, r]) => !r.success).map(([k]) => k);
    
    await dbClient
      .from("sync_runs")
      .update({
        status: failedSteps.length > 0 ? "completed_with_errors" : "completed",
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalFetched,
        error_message: failedSteps.length > 0 ? `Errors in: ${failedSteps.join(", ")}` : null,
        metadata: {
          ...((syncRun.metadata as Record<string, unknown>) || {}),
          results,
          completedAt: new Date().toISOString(),
        }
      })
      .eq("id", syncRunId);

    console.log(`✅ Sync completed: ${totalFetched} total records, ${failedSteps.length} failed steps`);

    return new Response(
      JSON.stringify({
        success: true,
        syncRunId,
        mode: config.mode,
        totalRecords: totalFetched,
        results,
        failedSteps: failedSteps.length > 0 ? failedSteps : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
