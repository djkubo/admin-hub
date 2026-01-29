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
  timedOut?: boolean;
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

  console.log("🚀 sync-command-center: Request received");
  const startTime = Date.now();
  const TIMEOUT_MS = 55000; // 55 seconds (Edge Functions have 60s limit)
  let timedOut = false;
  
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  
  // Track sync run ID and user email for error handling
  let syncRunId: string | null = null;
  let syncRun: SyncRun | null = null;
  let userEmailForError: string = "unknown";
  
  // Helper to check if we're running out of time
  const isTimeout = () => {
    const elapsed = Date.now() - startTime;
    if (elapsed > TIMEOUT_MS) {
      timedOut = true;
      console.warn(`⏱️ TIMEOUT WARNING: ${elapsed}ms elapsed, approaching 60s limit`);
      return true;
    }
    return false;
  };
  
  try {
    // ============ AUTHENTICATION ============
    const authHeader = req.headers.get("Authorization");
    console.log("🔐 Auth header present:", !!authHeader);
    
    if (!authHeader?.startsWith("Bearer ")) {
      console.error("❌ Missing or invalid Authorization header");
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

    // ============= KILL SWITCH: Check if sync is paused =============
    const { data: syncPausedConfig } = await dbClient
      .from('system_settings')
      .select('value')
      .eq('key', 'sync_paused')
      .single();

    const syncPaused = syncPausedConfig?.value === 'true';
    
    if (syncPaused) {
      console.log('⏸️ Sync paused globally, skipping command-center execution');
      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'skipped', 
          skipped: true, 
          reason: 'Feature disabled: sync_paused is ON' 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ================================================================

    // ============ PARSE CONFIG ============
    let config: SyncConfig & { forceCancel?: boolean } = { mode: 'today' };
    try {
      const body = await req.json() as Partial<SyncConfig & { forceCancel?: boolean }>;
      config = {
        mode: body.mode ?? 'today',
        startDate: body.startDate,
        endDate: body.endDate,
        includeContacts: body.includeContacts ?? false,
        forceCancel: body.forceCancel ?? false,
      };
    } catch {
      // Use defaults
    }

    // ============ FORCE CANCEL ALL SYNCS (ALL SOURCES) ============
    if (config.forceCancel) {
      console.log("🛑 Force cancelling ALL syncs from ALL sources...");
      const { data: cancelledSyncs, error: cancelError } = await dbClient
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(), 
          error_message: 'Cancelado forzosamente desde command-center' 
        })
        .in('status', ['running', 'continuing'])
        .select('id, source');

      const count = cancelledSyncs?.length || 0;
      console.log(`✅ Force cancelled ${count} syncs`, { error: cancelError });

      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'cancelled', 
          cancelled: count,
          details: cancelledSyncs,
          message: `Se cancelaron ${count} sincronizaciones de todas las fuentes` 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============ AUTO-CLEANUP STALE SYNCS (ALL SOURCES) ============
    // Clean up syncs older than 10 minutes from ANY source before starting
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: staleSyncs, error: staleError } = await dbClient
      .from('sync_runs')
      .update({ 
        status: 'failed', 
        completed_at: new Date().toISOString(), 
        error_message: 'Timeout - auto-cleanup by command-center (10min)' 
      })
      .in('status', ['running', 'continuing'])
      .lt('started_at', staleThreshold)
      .select('id, source');

    if (staleSyncs && staleSyncs.length > 0) {
      console.log(`🧹 Auto-cleaned ${staleSyncs.length} stale syncs:`, staleSyncs.map(s => `${s.source}:${s.id}`));
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
      console.error("❌ Failed to create sync run:", syncRunError);
      throw new Error(`Failed to create sync run: ${syncRunError.message}`);
    }

    syncRun = syncRunData as SyncRun;
    syncRunId = syncRun.id;
    console.log(`✅ Master sync run created: ${syncRunId}`);

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
    if (!isTimeout()) {
      try {
        await updateProgress("stripe-transactions", "Iniciando...");
        console.log("🔄 Starting Stripe transactions sync...");
        let totalStripe = 0;
        let hasMore = true;
        let cursor: string | null = null;
        let stripeSyncId: string | null = null;
        let pageCount = 0;
        const MAX_PAGES = config.mode === 'today' ? 5 : 20; // Reduce pages for safety
        
        while (hasMore && pageCount < MAX_PAGES && !isTimeout()) {
        pageCount++;
        console.log(`📄 Stripe page ${pageCount}, cursor: ${cursor ? 'yes' : 'none'}`);
        
        const response = await invokeClient.functions.invoke('fetch-stripe', {
          body: {
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            cursor,
            syncRunId: stripeSyncId,
          }
        });
        
        console.log(`📥 Stripe response:`, { 
          hasError: !!response.error, 
          hasData: !!response.data,
          status: (response.data as StripeSyncResponse)?.status 
        });
        
        const respData = response.data as StripeSyncResponse | null;
        if (response.error) {
          console.error("❌ Stripe invoke error:", response.error);
          throw response.error;
        }
        if (respData?.error === 'sync_already_running') {
          console.warn("⚠️ Stripe sync already running");
          results["stripe"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        const pageTxCount = respData?.synced_transactions ?? 0;
        totalStripe += pageTxCount;
        stripeSyncId = respData?.syncRunId ?? stripeSyncId;
        cursor = respData?.nextCursor ?? null;
        hasMore = respData?.hasMore === true && cursor !== null;
        
        console.log(`✅ Stripe page ${pageCount}: ${pageTxCount} tx, total: ${totalStripe}, hasMore: ${hasMore}`);
        await updateProgress("stripe-transactions", `${totalStripe} transacciones`);
      }
      
      if (pageCount >= MAX_PAGES) {
        console.warn(`⚠️ Stripe sync reached max pages limit (${MAX_PAGES})`);
      }
      
      if (!results["stripe"]) {
        results["stripe"] = { success: true, count: totalStripe };
      }
      console.log(`✅ Stripe sync completed: ${totalStripe} transactions`);
    } catch (e) {
      console.error("❌ Stripe sync error:", e);
      results["stripe"] = { success: false, count: 0, error: String(e) };
    }
    } else {
      console.warn("⏱️ Skipping Stripe transactions due to timeout");
      results["stripe"] = { success: false, count: 0, error: "Timeout" };
    }

    // ============ STRIPE SUBSCRIPTIONS ============
    if (!isTimeout()) {
      try {
      await updateProgress("stripe-subscriptions", "Iniciando...");
      console.log("🔄 Starting Stripe subscriptions sync...");
      const response = await invokeClient.functions.invoke('fetch-subscriptions');
      console.log("📥 Subscriptions response:", { hasError: !!response.error, hasData: !!response.data });
      const respData = response.data as GenericSyncResponse | null;
      if (response.error) {
        console.error("❌ Subscriptions invoke error:", response.error);
        throw response.error;
      }
        results["subscriptions"] = { success: true, count: respData?.synced ?? respData?.upserted ?? 0 };
        await updateProgress("stripe-subscriptions", `${results["subscriptions"].count} suscripciones`);
        console.log(`✅ Subscriptions sync completed: ${results["subscriptions"].count}`);
      } catch (e) {
        console.error("❌ Subscriptions sync error:", e);
        results["subscriptions"] = { success: false, count: 0, error: String(e) };
      }
    } else {
      console.warn("⏱️ Skipping Stripe subscriptions due to timeout");
      results["subscriptions"] = { success: false, count: 0, error: "Timeout" };
    }

    // ============ STRIPE INVOICES ============
    if (!isTimeout()) {
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
    } else {
      console.warn("⏱️ Skipping Stripe invoices due to timeout");
      results["invoices"] = { success: false, count: 0, error: "Timeout" };
    }

    // ============ STRIPE CUSTOMERS ============
    if (!isTimeout()) {
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
    } else {
      console.warn("⏱️ Skipping remaining Stripe syncs due to timeout");
    }

    // Skip non-critical syncs if we're running low on time
    if (!isTimeout() && config.mode !== 'today') {
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
    }

    // ============ PAYPAL TRANSACTIONS ============
    if (!isTimeout()) {
      try {
      await updateProgress("paypal-transactions", "Iniciando...");
      console.log("🔄 Starting PayPal transactions sync...");
      let totalPaypal = 0;
      let hasMore = true;
      let page = 1;
      let paypalSyncId: string | null = null;
        const MAX_PAGES = config.mode === 'today' ? 5 : 20; // Reduce pages for safety
      
        while (hasMore && page <= MAX_PAGES && !isTimeout()) {
        console.log(`📄 PayPal page ${page}`);
        
        const response = await invokeClient.functions.invoke('fetch-paypal', {
          body: {
            fetchAll: true,
            startDate: formatPayPalDate(startDate),
            endDate: formatPayPalDate(endDate),
            page,
            syncRunId: paypalSyncId,
          }
        });
        
        console.log(`📥 PayPal response:`, { 
          hasError: !!response.error, 
          hasData: !!response.data,
          status: (response.data as PayPalSyncResponse)?.status 
        });
        
        const respData = response.data as PayPalSyncResponse | null;
        if (response.error) {
          console.error("❌ PayPal invoke error:", response.error);
          throw response.error;
        }
        if (respData?.error === 'sync_already_running') {
          console.warn("⚠️ PayPal sync already running");
          results["paypal"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        const pageCount = respData?.synced_transactions ?? 0;
        totalPaypal += pageCount;
        paypalSyncId = respData?.syncRunId ?? paypalSyncId;
        hasMore = respData?.hasMore === true;
        page = respData?.nextPage ?? page + 1;
        
        console.log(`✅ PayPal page ${page - 1}: ${pageCount} tx, total: ${totalPaypal}, hasMore: ${hasMore}`);
        await updateProgress("paypal-transactions", `${totalPaypal} transacciones`);
      }
      
      if (page > MAX_PAGES) {
        console.warn(`⚠️ PayPal sync reached max pages limit (${MAX_PAGES})`);
      }
      
        if (!results["paypal"]) {
          results["paypal"] = { success: true, count: totalPaypal };
        }
        console.log(`✅ PayPal sync completed: ${totalPaypal} transactions`);
      } catch (e) {
        console.error("❌ PayPal sync error:", e);
        results["paypal"] = { success: false, count: 0, error: String(e) };
      }
    } else {
      console.warn("⏱️ Skipping PayPal transactions due to timeout");
      results["paypal"] = { success: false, count: 0, error: "Timeout" };
    }

    // Skip non-essential PayPal syncs if running low on time or in 'today' mode
    if (!isTimeout() && config.mode !== 'today') {
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
      timedOut: timedOut ? true : undefined,
    };

    const finalStatus = timedOut ? "completed_with_timeout" : 
                       failedSteps.length > 0 ? "completed_with_errors" : "completed";
    
    if (timedOut) {
      console.warn(`⏱️ Sync completed with timeout after ${Date.now() - startTime}ms. Some steps were skipped.`);
    }

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

    const duration = Date.now() - startTime;
    console.log(`✅ Sync completed: ${totalFetched} total records, ${failedSteps.length} failed steps in ${duration}ms`);
    console.log("📊 Final results:", Object.keys(results));

    const responseData = {
      success: true,
      status: finalStatus,
      syncRunId,
      mode: config.mode,
      totalRecords: totalFetched,
      results,
      failedSteps: failedSteps.length > 0 ? failedSteps : undefined,
      duration_ms: duration
    };
    
    console.log("📤 Sending response:", { success: responseData.success, status: responseData.status, totalRecords: responseData.totalRecords });

    return new Response(
      JSON.stringify(responseData),
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
