import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============= TYPE DEFINITIONS =============

interface SyncConfig {
  mode: 'today' | '7d' | 'month' | 'full';
  startDate?: string;
  endDate?: string;
  includeContacts?: boolean;
}

interface StripeSyncResponse {
  success: boolean;
  status?: string;
  error?: string;
  synced_transactions?: number;
  syncRunId?: string;
  nextCursor?: string;
  hasMore?: boolean;
}

interface PayPalSyncResponse {
  success: boolean;
  status?: string;
  error?: string;
  synced_transactions?: number;
  syncRunId?: string;
  nextPage?: number;
  hasMore?: boolean;
}

interface GenericSyncResponse {
  success: boolean;
  status?: string;
  error?: string;
  synced?: number;
  upserted?: number;
  unified?: number;
}

interface SyncStepResult {
  success: boolean;
  count: number;
  error?: string;
}

interface SyncRunMetadata {
  mode: string;
  startDate: string;
  endDate: string;
  authMethod: string;
  userEmail: string;
  steps: string[];
  currentStep?: string;
  lastUpdate?: string;
  results?: Record<string, SyncStepResult>;
  completedAt?: string;
}

interface SyncRun {
  id: string;
  metadata: SyncRunMetadata;
  total_fetched: number;
  total_inserted: number;
}

interface AdminVerifyResult {
  valid: boolean;
  error?: string;
  email?: string;
}

// ============= HELPERS =============

async function verifyAdmin(supabase: SupabaseClient): Promise<AdminVerifyResult> {
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

function formatPayPalDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ============= MAIN HANDLER =============

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const startTime = Date.now();
    
    // Track sync run ID and user email for error handling
    let syncRunId: string | null = null;
    let syncRun: SyncRun | null = null;
    let userEmailForError: string = "unknown";
  
  try {
    // ============ AUTHENTICATION ============
    const authHeader = req.headers.get("Authorization");
    
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ success: false, status: 'failed', error: "Missing or invalid Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    
    const authCheck = await verifyAdmin(authClient);
    
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ success: false, status: 'failed', error: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userEmail = authCheck.email ?? "";
    console.log("✅ Admin authenticated:", userEmail);
    
    // Store userEmail for error handling
    userEmailForError = userEmail;

    // ============ SEPARATE CLIENTS ============
    const dbClient = createClient(supabaseUrl, serviceRoleKey);
    const invokeClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // ============ PARSE CONFIG ============
    let config: SyncConfig = { mode: 'today' };
    try {
      const body = await req.json() as Partial<SyncConfig>;
      config = {
        mode: body.mode ?? 'today',
        startDate: body.startDate,
        endDate: body.endDate,
        includeContacts: body.includeContacts ?? false,
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
    const initialMetadata: SyncRunMetadata = {
      mode: config.mode,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      authMethod: "jwt+is_admin",
      userEmail,
      steps: [],
    };

    const { data: syncRunData, error: syncRunError } = await dbClient
      .from("sync_runs")
      .insert({
        source: "command-center",
        status: "running",
        metadata: initialMetadata
      })
      .select()
      .single();

    if (syncRunError) {
      throw new Error(`Failed to create sync run: ${syncRunError.message}`);
    }

    syncRun = syncRunData as SyncRun;
    syncRunId = syncRun.id;
    console.log(`📊 Master sync run created: ${syncRunId}`);

    // Helper to update progress
    const updateProgress = async (
      step: string, 
      details: string, 
      counts?: { fetched?: number; inserted?: number }
    ): Promise<void> => {
      const currentMetadata = (syncRun?.metadata ?? { steps: [] }) as SyncRunMetadata;
      const steps = [...(currentMetadata.steps ?? []), `${step}: ${details}`];
      
      const updateData: Record<string, unknown> = {
        metadata: { 
          ...currentMetadata, 
          steps, 
          currentStep: step, 
          lastUpdate: new Date().toISOString() 
        },
        checkpoint: { step, details, timestamp: new Date().toISOString() },
      };

      if (counts?.fetched) {
        updateData.total_fetched = ((syncRun?.total_fetched ?? 0) as number) + counts.fetched;
      }
      if (counts?.inserted) {
        updateData.total_inserted = ((syncRun?.total_inserted ?? 0) as number) + counts.inserted;
      }

      await dbClient
        .from("sync_runs")
        .update(updateData)
        .eq("id", syncRunId);
    };

    const results: Record<string, SyncStepResult> = {};

    // ============ STRIPE TRANSACTIONS ============
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
        
        const respData = response.data as StripeSyncResponse | null;
        if (response.error) throw response.error;
        if (respData?.error === 'sync_already_running') {
          results["stripe"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        totalStripe += respData?.synced_transactions ?? 0;
        stripeSyncId = respData?.syncRunId ?? stripeSyncId;
        cursor = respData?.nextCursor ?? null;
        hasMore = respData?.hasMore === true && cursor !== null;
        
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
      const response = await invokeClient.functions.invoke('fetch-subscriptions');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["subscriptions"] = { success: true, count: respData?.synced ?? respData?.upserted ?? 0 };
      await updateProgress("stripe-subscriptions", `${results["subscriptions"].count} suscripciones`);
    } catch (e) {
      console.error("Subscriptions sync error:", e);
      results["subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE INVOICES ============
    try {
      await updateProgress("stripe-invoices", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-invoices');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["invoices"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("stripe-invoices", `${results["invoices"].count} facturas`);
    } catch (e) {
      console.error("Invoices sync error:", e);
      results["invoices"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE CUSTOMERS ============
    try {
      await updateProgress("stripe-customers", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-customers');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["customers"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("stripe-customers", `${results["customers"].count} clientes`);
    } catch (e) {
      console.error("Customers sync error:", e);
      results["customers"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE PRODUCTS ============
    try {
      await updateProgress("stripe-products", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-products');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["products"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("stripe-products", `${results["products"].count} productos`);
    } catch (e) {
      console.error("Products sync error:", e);
      results["products"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE DISPUTES ============
    try {
      await updateProgress("stripe-disputes", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-disputes');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["disputes"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("stripe-disputes", `${results["disputes"].count} disputas`);
    } catch (e) {
      console.error("Disputes sync error:", e);
      results["disputes"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE PAYOUTS ============
    try {
      await updateProgress("stripe-payouts", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-payouts');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["payouts"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("stripe-payouts", `${results["payouts"].count} payouts`);
    } catch (e) {
      console.error("Payouts sync error:", e);
      results["payouts"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE BALANCE ============
    try {
      await updateProgress("stripe-balance", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-balance');
      if (response.error) throw response.error;
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
        const response = await invokeClient.functions.invoke('fetch-paypal', {
          body: {
            fetchAll: true,
            startDate: formatPayPalDate(startDate),
            endDate: formatPayPalDate(endDate),
            page,
            syncRunId: paypalSyncId,
          }
        });
        
        const respData = response.data as PayPalSyncResponse | null;
        if (response.error) throw response.error;
        if (respData?.error === 'sync_already_running') {
          results["paypal"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        totalPaypal += respData?.synced_transactions ?? 0;
        paypalSyncId = respData?.syncRunId ?? paypalSyncId;
        hasMore = respData?.hasMore === true;
        page = respData?.nextPage ?? page + 1;
        
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
      const response = await invokeClient.functions.invoke('fetch-paypal-subscriptions');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["paypal-subscriptions"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("paypal-subscriptions", `${results["paypal-subscriptions"].count} suscripciones`);
    } catch (e) {
      console.error("PayPal subscriptions sync error:", e);
      results["paypal-subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL DISPUTES ============
    try {
      await updateProgress("paypal-disputes", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-paypal-disputes');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["paypal-disputes"] = { success: true, count: respData?.synced ?? 0 };
      await updateProgress("paypal-disputes", `${results["paypal-disputes"].count} disputas`);
    } catch (e) {
      console.error("PayPal disputes sync error:", e);
      results["paypal-disputes"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL PRODUCTS ============
    try {
      await updateProgress("paypal-products", "Iniciando...");
      const response = await invokeClient.functions.invoke('fetch-paypal-products');
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) throw response.error;
      results["paypal-products"] = { success: true, count: respData?.synced ?? 0 };
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
        const response = await invokeClient.functions.invoke('sync-ghl');
        const respData = response.data as GenericSyncResponse | null;
        if (response.error) throw response.error;
        results["ghl"] = { success: true, count: respData?.synced ?? 0 };
        await updateProgress("ghl-contacts", `${results["ghl"].count} contactos`);
      } catch (e) {
        console.error("GHL sync error:", e);
        results["ghl"] = { success: false, count: 0, error: String(e) };
      }

      // ManyChat
      try {
        await updateProgress("manychat-contacts", "Iniciando...");
        const response = await invokeClient.functions.invoke('sync-manychat');
        const respData = response.data as GenericSyncResponse | null;
        if (response.error) throw response.error;
        results["manychat"] = { success: true, count: respData?.synced ?? 0 };
        await updateProgress("manychat-contacts", `${results["manychat"].count} contactos`);
      } catch (e) {
        console.error("ManyChat sync error:", e);
        results["manychat"] = { success: false, count: 0, error: String(e) };
      }

      // Unify identities
      try {
        await updateProgress("unify-identity", "Iniciando...");
        const response = await invokeClient.functions.invoke('unify-identity');
        const respData = response.data as GenericSyncResponse | null;
        if (response.error) throw response.error;
        results["unify"] = { success: true, count: respData?.unified ?? 0 };
        await updateProgress("unify-identity", `${results["unify"].count} identidades unificadas`);
      } catch (e) {
        console.error("Unify identity error:", e);
        results["unify"] = { success: false, count: 0, error: String(e) };
      }
    }

    // ============ COMPLETE SYNC RUN ============
    const totalFetched = Object.values(results).reduce((sum, r) => sum + r.count, 0);
    const failedSteps = Object.entries(results).filter(([, r]) => !r.success).map(([k]) => k);
    
    const finalMetadata: SyncRunMetadata = {
      ...(syncRun?.metadata || {}),
      results,
      completedAt: new Date().toISOString(),
    };

    const finalStatus = failedSteps.length > 0 ? "completed_with_errors" : "completed";

    await dbClient
      .from("sync_runs")
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalFetched,
        error_message: failedSteps.length > 0 ? `Errors in: ${failedSteps.join(", ")}` : null,
        metadata: finalMetadata
      })
      .eq("id", syncRunId);

    console.log(`✅ Sync completed: ${totalFetched} total records, ${failedSteps.length} failed steps in ${Date.now() - startTime}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: finalStatus,
        syncRunId,
        mode: config.mode,
        totalRecords: totalFetched,
        results,
        failedSteps: failedSteps.length > 0 ? failedSteps : undefined,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Fatal error:", errorMessage);
    
    // Try to update sync run if it exists
    if (syncRunId) {
      try {
        const dbClient = createClient(supabaseUrl, serviceRoleKey);
        await dbClient
          .from("sync_runs")
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
            metadata: {
              mode: 'unknown',
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              authMethod: "jwt+is_admin",
              userEmail: "unknown",
              steps: [],
              fatalError: errorMessage,
              completedAt: new Date().toISOString(),
            }
          })
          .eq("id", syncRunId);
      } catch (updateError) {
        console.error("Failed to update sync run:", updateError);
      }
    }
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        status: 'failed', 
        error: errorMessage,
        syncRunId: syncRunId || undefined
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
