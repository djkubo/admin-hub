import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============= TYPE DEFINITIONS =============

interface SyncConfig {
  startDate?: string;
  endDate?: string;
  fetchAll?: boolean;
  cursor?: string | null;
  limit?: number;
  includeContacts?: boolean;
  maxPages?: number;
  stripeCursor?: string | null;
  stripeSyncRunId?: string | null;
  subscriptionsCursor?: string | null;
  subscriptionsSyncRunId?: string | null;
  invoiceCursor?: string | null;
  invoiceSyncRunId?: string | null;
  paypalCursor?: string | null;
  paypalSyncRunId?: string | null;
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
  nextCursor?: string | null;
  hasMore?: boolean;
}

interface GenericSyncResponse {
  success: boolean;
  status?: string;
  error?: string;
  synced?: number;
  upserted?: number;
  unified?: number;
  syncRunId?: string;
  hasMore?: boolean;
  nextCursor?: string | null;
}

interface SyncStepResult {
  success: boolean;
  count: number;
  error?: string;
}

interface SyncRunMetadata {
  startDate: string;
  endDate: string;
  fetchAll: boolean;
  authMethod: string;
  userEmail: string;
  steps: string[];
  currentStep?: string;
  lastUpdate?: string;
  results?: Record<string, SyncStepResult>;
  completedAt?: string;
  stripe_cursor?: string | null;
  stripe_sync_run_id?: string | null;
  stripe_pages?: number;
  stripe_has_more?: boolean;
  subscriptions_cursor?: string | null;
  subscriptions_sync_run_id?: string | null;
  subscriptions_pages?: number;
  subscriptions_has_more?: boolean;
  invoice_cursor?: string | null;
  invoice_sync_run_id?: string | null;
  invoice_pages?: number;
  invoice_has_more?: boolean;
  paypal_cursor?: string | null;
  paypal_sync_run_id?: string | null;
  paypal_pages?: number;
  paypal_has_more?: boolean;
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

    // ============ SEPARATE CLIENTS ============
    const dbClient = createClient(supabaseUrl, serviceRoleKey);
    const invokeClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    // ============ PARSE CONFIG ============
    let config: SyncConfig = {};
    try {
      const body = await req.json() as Partial<SyncConfig>;
      config = {
        startDate: body.startDate,
        endDate: body.endDate,
        fetchAll: body.fetchAll ?? false,
        cursor: body.cursor ?? null,
        limit: body.limit,
        includeContacts: body.includeContacts ?? false,
        maxPages: body.maxPages,
        stripeCursor: body.stripeCursor ?? (body as { stripe_cursor?: string | null }).stripe_cursor ?? null,
        stripeSyncRunId: body.stripeSyncRunId ?? (body as { stripe_sync_run_id?: string | null }).stripe_sync_run_id ?? null,
        subscriptionsCursor: body.subscriptionsCursor ?? (body as { subscriptions_cursor?: string | null }).subscriptions_cursor ?? null,
        subscriptionsSyncRunId:
          body.subscriptionsSyncRunId ?? (body as { subscriptions_sync_run_id?: string | null }).subscriptions_sync_run_id ?? null,
        invoiceCursor: body.invoiceCursor ?? (body as { invoice_cursor?: string | null }).invoice_cursor ?? null,
        invoiceSyncRunId: body.invoiceSyncRunId ?? (body as { invoice_sync_run_id?: string | null }).invoice_sync_run_id ?? null,
        paypalCursor: body.paypalCursor ?? (body as { paypal_cursor?: string | null }).paypal_cursor ?? null,
        paypalSyncRunId: body.paypalSyncRunId ?? (body as { paypal_sync_run_id?: string | null }).paypal_sync_run_id ?? null,
      };
    } catch {
      // Use defaults
    }

    // Calculate date range defaults
    const now = new Date();
    let startDate = new Date(now);
    let endDate = now;

    startDate.setHours(0, 0, 0, 0);

    if (config.startDate) startDate = new Date(config.startDate);
    if (config.endDate) endDate = new Date(config.endDate);

    // ============ CREATE MASTER SYNC RUN ============
    const initialMetadata: SyncRunMetadata = {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      fetchAll: config.fetchAll ?? false,
      authMethod: "jwt+is_admin",
      userEmail,
      steps: [],
      stripe_cursor: config.stripeCursor ?? null,
      stripe_sync_run_id: config.stripeSyncRunId ?? null,
      subscriptions_cursor: config.subscriptionsCursor ?? null,
      subscriptions_sync_run_id: config.subscriptionsSyncRunId ?? null,
      invoice_cursor: config.invoiceCursor ?? null,
      invoice_sync_run_id: config.invoiceSyncRunId ?? null,
      paypal_cursor: config.paypalCursor ?? null,
      paypal_sync_run_id: config.paypalSyncRunId ?? null,
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

    const syncRun = syncRunData as SyncRun;
    const syncRunId = syncRun.id;
    console.log(`📊 Master sync run created: ${syncRunId}`);

    // Helper to update progress
    const updateProgress = async (
      step: string, 
      details: string, 
      counts?: { fetched?: number; inserted?: number },
      metadataUpdates?: Partial<SyncRunMetadata>
    ): Promise<void> => {
      const currentMetadata = syncRun.metadata ?? { steps: [] };
      const steps = [...(currentMetadata.steps ?? []), `${step}: ${details}`];
      
      const nextMetadata = {
        ...currentMetadata,
        ...metadataUpdates,
        steps,
        currentStep: step,
        lastUpdate: new Date().toISOString(),
      };

      const updateData: Record<string, unknown> = {
        metadata: nextMetadata,
        checkpoint: { step, details, timestamp: new Date().toISOString() },
      };

      if (counts?.fetched) {
        updateData.total_fetched = (syncRun.total_fetched ?? 0) + counts.fetched;
      }
      if (counts?.inserted) {
        updateData.total_inserted = (syncRun.total_inserted ?? 0) + counts.inserted;
      }

      await dbClient
        .from("sync_runs")
        .update(updateData)
        .eq("id", syncRunId);

      syncRun.metadata = nextMetadata;
    };

    const results: Record<string, SyncStepResult> = {};
    const continuingSteps: string[] = [];
    const maxPages = config.maxPages && config.maxPages > 0 ? config.maxPages : undefined;

    // ============ STRIPE TRANSACTIONS ============
    try {
      await updateProgress("stripe-transactions", "Iniciando...");
      let totalStripe = 0;
      let hasMore = true;
      let cursor: string | null = config.stripeCursor ?? null;
      let stripeSyncId: string | null = config.stripeSyncRunId ?? null;
      let pageCount = 0;
      
      while (hasMore) {
        if (maxPages && pageCount >= maxPages) {
          continuingSteps.push("stripe-transactions");
          await updateProgress(
            "stripe-transactions",
            `Continuando desde página ${pageCount + 1}`,
            undefined,
            {
              stripe_cursor: cursor,
              stripe_sync_run_id: stripeSyncId,
              stripe_pages: pageCount,
              stripe_has_more: hasMore,
            }
          );
          break;
        }
        const response = await invokeClient.functions.invoke('fetch-stripe', {
          body: {
            fetchAll: config.fetchAll ?? false,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            limit: config.limit,
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
        pageCount += 1;
        
        await updateProgress("stripe-transactions", `${totalStripe} transacciones`, undefined, {
          stripe_cursor: cursor,
          stripe_sync_run_id: stripeSyncId,
          stripe_pages: pageCount,
          stripe_has_more: hasMore,
        });
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
      let totalSubs = 0;
      let hasMore = true;
      let cursor: string | null = config.subscriptionsCursor ?? null;
      let subsSyncId: string | null = config.subscriptionsSyncRunId ?? null;
      let pageCount = 0;

      while (hasMore) {
        if (maxPages && pageCount >= maxPages) {
          continuingSteps.push("stripe-subscriptions");
          await updateProgress(
            "stripe-subscriptions",
            `Continuando desde página ${pageCount + 1}`,
            undefined,
            {
              subscriptions_cursor: cursor,
              subscriptions_sync_run_id: subsSyncId,
              subscriptions_pages: pageCount,
              subscriptions_has_more: hasMore,
            }
          );
          break;
        }
        const response = await invokeClient.functions.invoke('fetch-subscriptions', {
          body: { cursor, syncRunId: subsSyncId }
        });
        const respData = response.data as GenericSyncResponse | null;
        if (response.error) throw response.error;
        totalSubs += respData?.upserted ?? respData?.synced ?? 0;
        subsSyncId = (respData as { syncRunId?: string })?.syncRunId ?? subsSyncId;
        cursor = (respData as { nextCursor?: string | null })?.nextCursor ?? null;
        hasMore = (respData as { hasMore?: boolean })?.hasMore === true && cursor !== null;
        pageCount += 1;
        await updateProgress("stripe-subscriptions", `${totalSubs} suscripciones`, undefined, {
          subscriptions_cursor: cursor,
          subscriptions_sync_run_id: subsSyncId,
          subscriptions_pages: pageCount,
          subscriptions_has_more: hasMore,
        });
      }

      results["subscriptions"] = { success: true, count: totalSubs };
    } catch (e) {
      console.error("Subscriptions sync error:", e);
      results["subscriptions"] = { success: false, count: 0, error: String(e) };
    }

    // ============ STRIPE INVOICES ============
    try {
      await updateProgress("stripe-invoices", "Iniciando...");
      let totalInvoices = 0;
      let hasMore = true;
      let cursor: string | null = config.invoiceCursor ?? null;
      let invoicesSyncId: string | null = config.invoiceSyncRunId ?? null;
      let pageCount = 0;

      while (hasMore) {
        if (maxPages && pageCount >= maxPages) {
          continuingSteps.push("stripe-invoices");
          await updateProgress(
            "stripe-invoices",
            `Continuando desde página ${pageCount + 1}`,
            undefined,
            {
              invoice_cursor: cursor,
              invoice_sync_run_id: invoicesSyncId,
              invoice_pages: pageCount,
              invoice_has_more: hasMore,
            }
          );
          break;
        }
        const response = await invokeClient.functions.invoke('fetch-invoices', {
          body: {
            fetchAll: config.fetchAll ?? false,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            cursor,
            syncRunId: invoicesSyncId,
            limit: config.limit,
          }
        });
        const respData = response.data as GenericSyncResponse | null;
        if (response.error) throw response.error;

        totalInvoices += respData?.synced ?? 0;
        invoicesSyncId = (respData as { syncRunId?: string })?.syncRunId ?? invoicesSyncId;
        cursor = (respData as { nextCursor?: string | null })?.nextCursor ?? null;
        hasMore = (respData as { hasMore?: boolean })?.hasMore === true && cursor !== null;
        pageCount += 1;

        await updateProgress("stripe-invoices", `${totalInvoices} facturas`, undefined, {
          invoice_cursor: cursor,
          invoice_sync_run_id: invoicesSyncId,
          invoice_pages: pageCount,
          invoice_has_more: hasMore,
        });
      }

      results["invoices"] = { success: true, count: totalInvoices };
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
      let cursor: string | null = config.paypalCursor ?? null;
      let paypalSyncId: string | null = config.paypalSyncRunId ?? null;
      let pageCount = 0;
      
      while (hasMore) {
        if (maxPages && pageCount >= maxPages) {
          continuingSteps.push("paypal-transactions");
          await updateProgress(
            "paypal-transactions",
            `Continuando desde página ${pageCount + 1}`,
            undefined,
            {
              paypal_cursor: cursor,
              paypal_sync_run_id: paypalSyncId,
              paypal_pages: pageCount,
              paypal_has_more: hasMore,
            }
          );
          break;
        }
        const response = await invokeClient.functions.invoke('fetch-paypal', {
          body: {
            fetchAll: config.fetchAll ?? false,
            startDate: formatPayPalDate(startDate),
            endDate: formatPayPalDate(endDate),
            cursor,
            limit: config.limit,
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
        cursor = respData?.nextCursor ?? null;
        hasMore = respData?.hasMore === true && cursor !== null;
        pageCount += 1;
        
        await updateProgress("paypal-transactions", `${totalPaypal} transacciones`, undefined, {
          paypal_cursor: cursor,
          paypal_sync_run_id: paypalSyncId,
          paypal_pages: pageCount,
          paypal_has_more: hasMore,
        });
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
    
    const finalStatus = continuingSteps.length > 0
      ? "continuing"
      : (failedSteps.length > 0 ? "completed_with_errors" : "completed");

    const finalMetadata: SyncRunMetadata = {
      ...syncRun.metadata,
      results,
      completedAt: finalStatus === "continuing" ? undefined : new Date().toISOString(),
    };

    await dbClient
      .from("sync_runs")
      .update({
        status: finalStatus,
        completed_at: continuingSteps.length > 0 ? null : new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalFetched,
        error_message: failedSteps.length > 0 ? `Errors in: ${failedSteps.join(", ")}` : null,
        metadata: finalMetadata,
      })
      .eq("id", syncRunId);

    console.log(`✅ Sync completed: ${totalFetched} total records, ${failedSteps.length} failed steps in ${Date.now() - startTime}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: finalStatus,
        syncRunId,
        totalRecords: totalFetched,
        results,
        continuingSteps: continuingSteps.length > 0 ? continuingSteps : undefined,
        failedSteps: failedSteps.length > 0 ? failedSteps : undefined,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, status: 'failed', error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
