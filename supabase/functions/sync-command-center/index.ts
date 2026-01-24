import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SyncConfig {
  mode: 'today' | '7d' | 'month' | 'full';
  startDate?: string;
  endDate?: string;
  includeContacts?: boolean;
}

interface SyncProgress {
  step: string;
  current: number;
  total: number;
  details: string;
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
    const adminKeyHeader = req.headers.get("x-admin-key");
    
    let isAuthenticated = false;
    let authMethod = "";
    let userEmail = "";

    // Method 1: JWT Bearer token (preferred for frontend)
    if (authHeader?.startsWith("Bearer ")) {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } }
      });
      
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (!userError && user) {
        // Verify user is admin using is_admin() RPC
        const { data: isAdmin } = await supabase.rpc('is_admin');
        if (isAdmin === true) {
          isAuthenticated = true;
          authMethod = "jwt+is_admin";
          userEmail = user.email || "";
          console.log("✅ Admin authenticated:", userEmail);
        } else {
          console.log("❌ User is not admin:", user.email);
        }
      }
    }

    // Method 2: x-admin-key header (for external scripts/cron)
    if (!isAuthenticated && adminKeyHeader) {
      const serviceClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: settings } = await serviceClient
        .from("system_settings")
        .select("value")
        .eq("key", "admin_api_key")
        .single();

      if (settings?.value && adminKeyHeader === settings.value) {
        isAuthenticated = true;
        authMethod = "admin-key";
        console.log("✅ Authenticated via admin key (external script)");
      }
    }

    if (!isAuthenticated) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized: Admin access required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // ============ CREATE MASTER SYNC RUN ============
    const { data: syncRun, error: syncRunError } = await serviceClient
      .from("sync_runs")
      .insert({
        source: "command-center",
        status: "running",
        metadata: {
          mode: config.mode,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          authMethod,
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
      
      await serviceClient
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
        const response = await serviceClient.functions.invoke('fetch-stripe', {
          body: {
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            cursor,
            syncRunId: stripeSyncId,
          },
          headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
        });
        
        const stripeData = response.data as Record<string, unknown> | null;
        if (response.error) throw response.error;
        if (stripeData?.error === 'sync_already_running') {
          results["stripe"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        totalStripe += (stripeData?.synced_transactions as number) || 0;
        stripeSyncId = (stripeData?.syncRunId as string) || stripeSyncId;
        cursor = (stripeData?.nextCursor as string) || null;
        hasMore = stripeData?.hasMore === true && cursor !== null;
        
        await updateProgress("stripe-transactions", `${totalStripe} transacciones`);
      }
      results["stripe"] = { success: true, count: totalStripe };
    } catch (e) {
      console.error("Stripe sync error:", e);
      results["stripe"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE SUBSCRIPTIONS ============
    try {
      await updateProgress("stripe-subscriptions", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-subscriptions', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["subscriptions"] = { success: true, count: data?.synced || data?.upserted || 0 };
      await updateProgress("stripe-subscriptions", `${results["subscriptions"].count} suscripciones`);
    } catch (e) {
      console.error("Subscriptions sync error:", e);
      results["subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE INVOICES ============
    try {
      await updateProgress("stripe-invoices", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-invoices', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["invoices"] = { success: true, count: data?.synced || 0 };
      await updateProgress("stripe-invoices", `${results["invoices"].count} facturas`);
    } catch (e) {
      console.error("Invoices sync error:", e);
      results["invoices"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE CUSTOMERS ============
    try {
      await updateProgress("stripe-customers", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-customers', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["customers"] = { success: true, count: data?.synced || 0 };
      await updateProgress("stripe-customers", `${results["customers"].count} clientes`);
    } catch (e) {
      console.error("Customers sync error:", e);
      results["customers"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE PRODUCTS ============
    try {
      await updateProgress("stripe-products", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-products', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["products"] = { success: true, count: data?.synced || 0 };
      await updateProgress("stripe-products", `${results["products"].count} productos`);
    } catch (e) {
      console.error("Products sync error:", e);
      results["products"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE DISPUTES ============
    try {
      await updateProgress("stripe-disputes", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-disputes', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["disputes"] = { success: true, count: data?.synced || 0 };
      await updateProgress("stripe-disputes", `${results["disputes"].count} disputas`);
    } catch (e) {
      console.error("Disputes sync error:", e);
      results["disputes"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE PAYOUTS ============
    try {
      await updateProgress("stripe-payouts", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-payouts', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["payouts"] = { success: true, count: data?.synced || 0 };
      await updateProgress("stripe-payouts", `${results["payouts"].count} payouts`);
    } catch (e) {
      console.error("Payouts sync error:", e);
      results["payouts"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE BALANCE ============
    try {
      await updateProgress("stripe-balance", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-balance', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
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
        const { data, error } = await serviceClient.functions.invoke('fetch-paypal', {
          body: {
            fetchAll: true,
            startDate: formatPayPalDate(startDate),
            endDate: formatPayPalDate(endDate),
            page,
            syncRunId: paypalSyncId,
          },
          headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
        });
        
        if (error) throw error;
        if (data?.error === 'sync_already_running') {
          results["paypal"] = { success: false, count: 0, error: "sync_already_running" };
          break;
        }
        
        totalPaypal += data?.synced_transactions || 0;
        paypalSyncId = data?.syncRunId || paypalSyncId;
        hasMore = data?.hasMore === true;
        page = data?.nextPage || page + 1;
        
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
      const { data, error } = await serviceClient.functions.invoke('fetch-paypal-subscriptions', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["paypal-subscriptions"] = { success: true, count: data?.synced || 0 };
      await updateProgress("paypal-subscriptions", `${results["paypal-subscriptions"].count} suscripciones`);
    } catch (e) {
      console.error("PayPal subscriptions sync error:", e);
      results["paypal-subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL DISPUTES ============
    try {
      await updateProgress("paypal-disputes", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-paypal-disputes', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["paypal-disputes"] = { success: true, count: data?.synced || 0 };
      await updateProgress("paypal-disputes", `${results["paypal-disputes"].count} disputas`);
    } catch (e) {
      console.error("PayPal disputes sync error:", e);
      results["paypal-disputes"] = { success: false, count: 0, error: String(e) };
    }

    // ============ PAYPAL PRODUCTS ============
    try {
      await updateProgress("paypal-products", "Iniciando...");
      const { data, error } = await serviceClient.functions.invoke('fetch-paypal-products', {
        headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
      });
      if (error) throw error;
      results["paypal-products"] = { success: true, count: data?.synced || 0 };
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
        const { data, error } = await serviceClient.functions.invoke('sync-ghl', {
          headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
        });
        if (error) throw error;
        results["ghl"] = { success: true, count: data?.synced || 0 };
        await updateProgress("ghl-contacts", `${results["ghl"].count} contactos`);
      } catch (e) {
        console.error("GHL sync error:", e);
        results["ghl"] = { success: false, count: 0, error: String(e) };
      }

      // ManyChat
      try {
        await updateProgress("manychat-contacts", "Iniciando...");
        const { data, error } = await serviceClient.functions.invoke('sync-manychat', {
          headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
        });
        if (error) throw error;
        results["manychat"] = { success: true, count: data?.synced || 0 };
        await updateProgress("manychat-contacts", `${results["manychat"].count} contactos`);
      } catch (e) {
        console.error("ManyChat sync error:", e);
        results["manychat"] = { success: false, count: 0, error: String(e) };
      }

      // Unify identities
      try {
        await updateProgress("unify-identity", "Iniciando...");
        const { data, error } = await serviceClient.functions.invoke('unify-identity', {
          headers: { 'x-admin-key': Deno.env.get("ADMIN_API_KEY") || '' }
        });
        if (error) throw error;
        results["unify"] = { success: true, count: data?.unified || 0 };
        await updateProgress("unify-identity", `${results["unify"].count} identidades unificadas`);
      } catch (e) {
        console.error("Unify identity error:", e);
        results["unify"] = { success: false, count: 0, error: String(e) };
      }
    }

    // ============ COMPLETE SYNC RUN ============
    const totalFetched = Object.values(results).reduce((sum, r) => sum + r.count, 0);
    const failedSteps = Object.entries(results).filter(([, r]) => !r.success).map(([k]) => k);
    
    await serviceClient
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
        totalFetched,
        results,
        failedSteps,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Command center sync error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
