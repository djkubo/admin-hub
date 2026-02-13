// Edge Function: bulk-unify-contacts v6
// Single batch per invocation + auto-chaining (EdgeRuntime.waitUntil).
// Uses merge_contact() to unify identities consistently with the rest of the system.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from "../_shared/logger.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const logger = createLogger("bulk-unify-contacts", LogLevel.INFO);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Source = "ghl" | "manychat" | "csv";

interface BulkUnifyBody {
  sources?: Source[];
  batchSize?: number;
  syncRunId?: string;
  importId?: string;
  forceCancel?: boolean;

  // Internal (auto-chain)
  isChainedCall?: boolean;
}

interface PendingCounts {
  ghl: number;
  manychat: number;
  csv: number;
  total: number;
}

interface BatchTotals {
  processed: number;
  inserted: number;
  updated: number;
  conflicts: number;
  skipped: number;
  errors: number;
}

interface SyncRunRow {
  id: string;
  status: string;
  total_fetched: number | null;
  total_inserted: number | null;
  total_updated: number | null;
  total_skipped: number | null;
  total_conflicts: number | null;
  checkpoint: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  error_message: string | null;
}

const DEFAULT_SOURCES: Source[] = ["ghl", "manychat", "csv"];
const BATCH_SIZE_DEFAULT = 50;
const BATCH_SIZE_MAX = 100;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clampBatchSize(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return BATCH_SIZE_DEFAULT;
  const rounded = Math.floor(n);
  return Math.max(1, Math.min(rounded, BATCH_SIZE_MAX));
}

function isCancelledStatus(status: string | null | undefined): boolean {
  return status === "cancelled" || status === "canceled";
}

async function verifyAdminOrServiceRole(req: Request): Promise<{ valid: boolean; isServiceRole: boolean; error?: string }> {
  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  // Allow service role token for internal auto-chaining.
  if (authHeader.startsWith("Bearer ") && serviceRoleKey) {
    const token = authHeader.slice("Bearer ".length);
    if (token === serviceRoleKey) {
      return { valid: true, isServiceRole: true };
    }
  }

  // Require a real JWT for panel calls.
  if (!authHeader.startsWith("Bearer ")) {
    return { valid: false, isServiceRole: false, error: "Missing Authorization header" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: isAdmin, error: adminError } = await (supabase as any).rpc("is_admin");
  if (adminError) {
    return { valid: false, isServiceRole: false, error: `Auth check failed: ${adminError.message}` };
  }
  if (!isAdmin) {
    return { valid: false, isServiceRole: false, error: "Not authorized as admin" };
  }

  return { valid: true, isServiceRole: false };
}

async function fetchSyncRun(supabase: any, syncRunId: string): Promise<SyncRunRow | null> {
  const { data, error } = await supabase
    .from("sync_runs")
    .select(
      "id,status,total_fetched,total_inserted,total_updated,total_skipped,total_conflicts,checkpoint,metadata,error_message",
    )
    .eq("id", syncRunId)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch sync run: ${error.message}`);
  return (data as SyncRunRow | null) || null;
}

async function findLatestActiveBulkUnifyRun(supabase: any): Promise<SyncRunRow | null> {
  const { data, error } = await supabase
    .from("sync_runs")
    .select(
      "id,status,total_fetched,total_inserted,total_updated,total_skipped,total_conflicts,checkpoint,metadata,error_message",
    )
    .eq("source", "bulk_unify")
    .in("status", ["running", "continuing", "paused"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to query active sync run: ${error.message}`);
  return (data as SyncRunRow | null) || null;
}

async function countPendingRecords(supabase: any, sources: Source[], importId?: string): Promise<PendingCounts> {
  const want = new Set(sources);

  const ghlPromise = want.has("ghl")
    ? supabase.from("ghl_contacts_raw").select("id", { count: "exact", head: true }).is("processed_at", null)
    : Promise.resolve({ count: 0 });
  const mcPromise = want.has("manychat")
    ? supabase.from("manychat_contacts_raw").select("id", { count: "exact", head: true }).is("processed_at", null)
    : Promise.resolve({ count: 0 });

  const csvBase = want.has("csv")
    ? supabase
        .from("csv_imports_raw")
        .select("id", { count: "exact", head: true })
        .is("processed_at", null)
        .in("processing_status", ["pending", "staged"])
    : null;
  const csvPromise = csvBase ? (importId ? csvBase.eq("import_id", importId) : csvBase) : Promise.resolve({ count: 0 });

  const [ghlRes, mcRes, csvRes] = await Promise.all([ghlPromise, mcPromise, csvPromise]);

  const pending: PendingCounts = {
    ghl: (ghlRes as any).count || 0,
    manychat: (mcRes as any).count || 0,
    csv: (csvRes as any).count || 0,
    total: 0,
  };
  pending.total = pending.ghl + pending.manychat + pending.csv;
  return pending;
}

function emptyTotals(): BatchTotals {
  return { processed: 0, inserted: 0, updated: 0, conflicts: 0, skipped: 0, errors: 0 };
}

function addTotals(a: BatchTotals, b: BatchTotals): BatchTotals {
  return {
    processed: a.processed + b.processed,
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    conflicts: a.conflicts + b.conflicts,
    skipped: a.skipped + b.skipped,
    errors: a.errors + b.errors,
  };
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object" && "name" in (t as any) && typeof (t as any).name === "string") return (t as any).name;
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

async function processGHLBatch(supabase: any, syncRunId: string, batchSize: number): Promise<BatchTotals> {
  const totals = emptyTotals();

  const { data: rawContacts, error: fetchError } = await supabase
    .from("ghl_contacts_raw")
    .select("id, external_id, payload, processed_at")
    .is("processed_at", null)
    .order("fetched_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    logger.error("Error fetching GHL raw contacts", new Error(fetchError.message));
    totals.errors += 1;
    return totals;
  }

  const contacts = (rawContacts || []) as Array<{ id: string; external_id: string; payload: any }>;
  if (contacts.length === 0) return totals;

  logger.info("Processing GHL batch", { count: contacts.length, batchSize });

  for (const contact of contacts) {
    try {
      const payload = contact.payload || {};
      const email = (payload.email as string) || null;
      const phone = (payload.phone as string) || null;

      if (!email && !phone) {
        await supabase.from("ghl_contacts_raw").update({ processed_at: new Date().toISOString() }).eq("id", contact.id);
        totals.processed++;
        totals.skipped++;
        continue;
      }

      const firstName = (payload.firstName as string) || "";
      const lastName = (payload.lastName as string) || "";
      const fullName =
        (payload.contactName as string) || [firstName, lastName].filter(Boolean).join(" ") || null;
      const tags = normalizeTags(payload.tags as unknown);

      const dndSettings = payload.dndSettings as Record<string, { status?: string }> | undefined;
      const inboundDndSettings = payload.inboundDndSettings as Record<string, { status?: string }> | undefined;
      const waOptIn =
        !payload.dnd &&
        dndSettings?.whatsApp?.status !== "active" &&
        inboundDndSettings?.whatsApp?.status !== "active";
      const smsOptIn =
        !payload.dnd && dndSettings?.sms?.status !== "active" && inboundDndSettings?.sms?.status !== "active";
      const emailOptIn =
        !payload.dnd && dndSettings?.email?.status !== "active" && inboundDndSettings?.email?.status !== "active";

      const { data: mergeResult, error: mergeError } = await (supabase as any).rpc("merge_contact", {
        p_source: "ghl",
        p_external_id: contact.external_id,
        p_email: email,
        p_phone: phone,
        p_full_name: fullName,
        p_tags: tags,
        p_wa_opt_in: waOptIn,
        p_sms_opt_in: smsOptIn,
        p_email_opt_in: emailOptIn,
        p_extra_data: payload,
        p_dry_run: false,
        p_sync_run_id: syncRunId,
      });

      if (mergeError) {
        logger.error(`Merge error for GHL contact ${contact.external_id}`, new Error(mergeError.message));
        totals.errors++;
      } else {
        const action = (mergeResult as { action?: string })?.action;
        if (action === "inserted") totals.inserted++;
        else if (action === "updated") totals.updated++;
        else if (action === "conflict") totals.conflicts++;
      }

      await supabase.from("ghl_contacts_raw").update({ processed_at: new Date().toISOString() }).eq("id", contact.id);
      totals.processed++;
    } catch (err) {
      logger.error("Error processing GHL contact", err instanceof Error ? err : new Error(String(err)));
      totals.errors++;
    }
  }

  return totals;
}

async function processManyChatBatch(supabase: any, syncRunId: string, batchSize: number): Promise<BatchTotals> {
  const totals = emptyTotals();

  const { data: rawContacts, error: fetchError } = await supabase
    .from("manychat_contacts_raw")
    .select("id, subscriber_id, payload, processed_at")
    .is("processed_at", null)
    .order("fetched_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    logger.error("Error fetching ManyChat raw contacts", new Error(fetchError.message));
    totals.errors += 1;
    return totals;
  }

  const contacts = (rawContacts || []) as Array<{ id: string; subscriber_id: string; payload: any }>;
  if (contacts.length === 0) return totals;

  logger.info("Processing ManyChat batch", { count: contacts.length, batchSize });

  for (const contact of contacts) {
    try {
      const payload = contact.payload || {};
      const email = (payload.email as string) || null;
      const phone = (payload.phone as string) || (payload.whatsapp_phone as string) || null;

      if (!email && !phone) {
        await supabase.from("manychat_contacts_raw").update({ processed_at: new Date().toISOString() }).eq("id", contact.id);
        totals.processed++;
        totals.skipped++;
        continue;
      }

      const fullName =
        [payload.first_name, payload.last_name].filter(Boolean).join(" ") || (payload.name as string) || null;
      const tags = normalizeTags(payload.tags as unknown);

      // Use nulls when unknown to avoid overwriting existing opt-in flags.
      const waOptIn = typeof payload.optin_whatsapp === "boolean" ? payload.optin_whatsapp : null;
      const smsOptIn = typeof payload.optin_sms === "boolean" ? payload.optin_sms : null;
      const emailOptIn = typeof payload.optin_email === "boolean" ? payload.optin_email : null;

      const { data: mergeResult, error: mergeError } = await (supabase as any).rpc("merge_contact", {
        p_source: "manychat",
        p_external_id: contact.subscriber_id,
        p_email: email,
        p_phone: phone,
        p_full_name: fullName,
        p_tags: tags,
        p_wa_opt_in: waOptIn,
        p_sms_opt_in: smsOptIn,
        p_email_opt_in: emailOptIn,
        p_extra_data: payload,
        p_dry_run: false,
        p_sync_run_id: syncRunId,
      });

      if (mergeError) {
        logger.error(`Merge error for ManyChat contact ${contact.subscriber_id}`, new Error(mergeError.message));
        totals.errors++;
      } else {
        const action = (mergeResult as { action?: string })?.action;
        if (action === "inserted") totals.inserted++;
        else if (action === "updated") totals.updated++;
        else if (action === "conflict") totals.conflicts++;
      }

      await supabase.from("manychat_contacts_raw").update({ processed_at: new Date().toISOString() }).eq("id", contact.id);
      totals.processed++;
    } catch (err) {
      logger.error("Error processing ManyChat contact", err instanceof Error ? err : new Error(String(err)));
      totals.errors++;
    }
  }

  return totals;
}

async function processCSVBatch(
  supabase: any,
  syncRunId: string,
  batchSize: number,
  importId?: string,
): Promise<BatchTotals> {
  const totals = emptyTotals();

  let query = supabase
    .from("csv_imports_raw")
    .select("id, import_id, email, phone, full_name, raw_data, processing_status, source_type, processed_at")
    .is("processed_at", null)
    .in("processing_status", ["pending", "staged"])
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (importId) query = query.eq("import_id", importId);

  const { data: rawContacts, error: fetchError } = await query;

  if (fetchError) {
    logger.error("Error fetching CSV raw contacts", new Error(fetchError.message));
    totals.errors += 1;
    return totals;
  }

  const contacts = (rawContacts || []) as Array<{
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    raw_data: Record<string, unknown>;
    source_type: string;
  }>;

  if (contacts.length === 0) return totals;

  logger.info("Processing CSV batch", { count: contacts.length, batchSize, importId: importId || null });

  for (const contact of contacts) {
    try {
      if (!contact.email && !contact.phone) {
        await supabase
          .from("csv_imports_raw")
          .update({ processing_status: "skipped", error_message: "No email or phone", processed_at: new Date().toISOString() })
          .eq("id", contact.id);
        totals.processed++;
        totals.skipped++;
        continue;
      }

      const extraData = contact.raw_data || {};
      const tags = normalizeTags((extraData as any).tags);

      const { data: mergeResult, error: mergeError } = await (supabase as any).rpc("merge_contact", {
        p_source: "csv",
        p_external_id: contact.id,
        p_email: contact.email,
        p_phone: contact.phone,
        p_full_name: contact.full_name,
        p_tags: tags,
        p_wa_opt_in: null,
        p_sms_opt_in: null,
        p_email_opt_in: null,
        p_extra_data: extraData,
        p_dry_run: false,
        p_sync_run_id: syncRunId,
      });

      if (mergeError) {
        logger.error(`Merge error for CSV contact ${contact.id}`, new Error(mergeError.message));
        await supabase
          .from("csv_imports_raw")
          .update({
            processing_status: "error",
            error_message: mergeError.message,
            processed_at: new Date().toISOString(),
          })
          .eq("id", contact.id);
        totals.errors++;
      } else {
        const action = (mergeResult as { action?: string; client_id?: string })?.action;
        const clientId = (mergeResult as { client_id?: string })?.client_id || null;

        if (action === "inserted") totals.inserted++;
        else if (action === "updated") totals.updated++;
        else if (action === "conflict") totals.conflicts++;

        const nextStatus = action === "conflict" ? "conflict" : "merged";
        await supabase
          .from("csv_imports_raw")
          .update({
            processing_status: nextStatus,
            merged_client_id: clientId,
            processed_at: new Date().toISOString(),
          })
          .eq("id", contact.id);
      }

      totals.processed++;
    } catch (err) {
      logger.error("Error processing CSV contact", err instanceof Error ? err : new Error(String(err)));
      totals.errors++;
    }
  }

  return totals;
}

async function invokeNextChunk(params: {
  supabaseUrl: string;
  serviceRoleKey: string;
  syncRunId: string;
  batchSize: number;
  sources: Source[];
  importId?: string;
  chunk: number;
}): Promise<{ ok: boolean }> {
  const { supabaseUrl, serviceRoleKey, syncRunId, batchSize, sources, importId, chunk } = params;
  const body: BulkUnifyBody = { syncRunId, batchSize, sources, importId, isChainedCall: true };

  await delay(500);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/bulk-unify-contacts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        logger.info("Chain invocation succeeded", { syncRunId, attempt, chunk });
        return { ok: true };
      }

      logger.warn("Chain invocation returned non-2xx", { syncRunId, attempt, chunk, status: res.status });
    } catch (e) {
      logger.warn("Chain invocation failed", { syncRunId, attempt, chunk, error: String(e) });
    }

    await delay(2000 * attempt);
  }

  return { ok: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await verifyAdminOrServiceRole(req);
  if (!auth.valid) {
    return new Response(JSON.stringify({ ok: false, error: auth.error || "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const startedAt = Date.now();

  let syncRunId: string | undefined;

  try {
    const body = (await req.json().catch(() => ({}))) as BulkUnifyBody;

    const batchSize = clampBatchSize(body.batchSize);
    const sources = Array.isArray(body.sources) && body.sources.length > 0 ? body.sources : DEFAULT_SOURCES;
    const importId = typeof body.importId === "string" && body.importId.length > 0 ? body.importId : undefined;
    const requestedSyncRunId = typeof body.syncRunId === "string" && body.syncRunId.length > 0 ? body.syncRunId : undefined;
    const isChainedCall = body.isChainedCall === true;
    const forceCancel = body.forceCancel === true;

    logger.info("Bulk unify request", {
      syncRunId: requestedSyncRunId || null,
      batchSize,
      sources,
      isChainedCall,
      importId: importId || null,
      forceCancel,
    });

    // Cancel: either by id or cancel all active bulk_unify runs.
    if (forceCancel) {
      let q = supabase
        .from("sync_runs")
        .update({
          status: "cancelled",
          completed_at: new Date().toISOString(),
          error_message: "Cancelado por el usuario",
        })
        .eq("source", "bulk_unify")
        .in("status", ["running", "continuing", "paused"]);

      if (requestedSyncRunId) q = q.eq("id", requestedSyncRunId);

      const { data: cancelled, error: cancelError } = await q.select("id");
      if (cancelError) throw new Error(`Cancel failed: ${cancelError.message}`);

      return new Response(
        JSON.stringify({ ok: true, status: "cancelled", cancelled: (cancelled || []).length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // If no id provided, reuse a running/paused run to avoid duplicates.
    let syncRun: SyncRunRow | null = requestedSyncRunId
      ? await fetchSyncRun(supabase, requestedSyncRunId)
      : await findLatestActiveBulkUnifyRun(supabase);
    syncRunId = syncRun?.id || requestedSyncRunId;

    const pendingBefore = await countPendingRecords(supabase, sources, importId);
    if (pendingBefore.total === 0) {
      if (syncRunId) {
        await supabase
          .from("sync_runs")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", syncRunId);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          status: "no_work",
          message: "No hay registros pendientes de unificar",
          pending: pendingBefore,
          duration_ms: Date.now() - startedAt,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Create sync run if needed.
    if (!syncRunId) {
      const nowIso = new Date().toISOString();
      const { data: created, error: createError } = await supabase
        .from("sync_runs")
        .insert({
          source: "bulk_unify",
          status: "running",
          total_fetched: 0,
          total_inserted: 0,
          total_updated: 0,
          total_skipped: 0,
          total_conflicts: 0,
          checkpoint: {
            chunk: 0,
            runningTotal: 0,
            progressPct: 0,
            lastActivity: nowIso,
            canResume: false,
            errorCount: 0,
          },
          metadata: {
            sources,
            batchSize,
            pending: pendingBefore,
            importId: importId || null,
          },
        })
        .select(
          "id,status,total_fetched,total_inserted,total_updated,total_skipped,total_conflicts,checkpoint,metadata,error_message",
        )
        .single();

      if (createError) throw new Error(`Failed to create sync run: ${createError.message}`);

      syncRun = created as unknown as SyncRunRow;
      syncRunId = syncRun.id;
    } else if (!syncRun) {
      // syncRunId provided but not found: create a new one.
      const nowIso = new Date().toISOString();
      const { data: created, error: createError } = await supabase
        .from("sync_runs")
        .insert({
          source: "bulk_unify",
          status: "running",
          total_fetched: 0,
          total_inserted: 0,
          total_updated: 0,
          total_skipped: 0,
          total_conflicts: 0,
          checkpoint: {
            chunk: 0,
            runningTotal: 0,
            progressPct: 0,
            lastActivity: nowIso,
            canResume: false,
            errorCount: 0,
          },
          metadata: {
            sources,
            batchSize,
            pending: pendingBefore,
            importId: importId || null,
          },
        })
        .select(
          "id,status,total_fetched,total_inserted,total_updated,total_skipped,total_conflicts,checkpoint,metadata,error_message",
        )
        .single();

      if (createError) throw new Error(`Failed to create sync run: ${createError.message}`);

      syncRun = created as unknown as SyncRunRow;
      syncRunId = syncRun.id;
    }

    // If run was cancelled, do not continue.
    if (syncRun && isCancelledStatus(syncRun.status)) {
      return new Response(
        JSON.stringify({ ok: true, status: "cancelled", syncRunId, pending: pendingBefore, remainingPending: pendingBefore }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // If paused, flip back to running.
    if (syncRun && syncRun.status === "paused") {
      await supabase.from("sync_runs").update({ status: "running", error_message: null }).eq("id", syncRunId);
    }

    // Process ONE batch per source.
    let batchTotals = emptyTotals();

    if (sources.includes("ghl") && pendingBefore.ghl > 0) {
      batchTotals = addTotals(batchTotals, await processGHLBatch(supabase, syncRunId!, batchSize));
    }
    if (sources.includes("manychat") && pendingBefore.manychat > 0) {
      batchTotals = addTotals(batchTotals, await processManyChatBatch(supabase, syncRunId!, batchSize));
    }
    if (sources.includes("csv") && pendingBefore.csv > 0) {
      batchTotals = addTotals(batchTotals, await processCSVBatch(supabase, syncRunId!, batchSize, importId));
    }

    const remainingPending = await countPendingRecords(supabase, sources, importId);
    const hasMore = remainingPending.total > 0;

    const current = await fetchSyncRun(supabase, syncRunId!);
    const prevFetched = current?.total_fetched || 0;
    const prevInserted = current?.total_inserted || 0;
    const prevUpdated = current?.total_updated || 0;
    const prevSkipped = current?.total_skipped || 0;
    const prevConflicts = current?.total_conflicts || 0;

    const prevCheckpoint = (current?.checkpoint || {}) as Record<string, unknown>;
    const prevChunk = typeof prevCheckpoint.chunk === "number" ? (prevCheckpoint.chunk as number) : 0;
    const prevErrorCount = typeof prevCheckpoint.errorCount === "number" ? (prevCheckpoint.errorCount as number) : 0;

    const nextChunk = prevChunk + 1;
    const totalFetched = prevFetched + batchTotals.processed;
    const totalInserted = prevInserted + batchTotals.inserted;
    const totalUpdated = prevUpdated + batchTotals.updated;
    const totalSkipped = prevSkipped + batchTotals.skipped;
    const totalConflicts = prevConflicts + batchTotals.conflicts;
    const errorCount = prevErrorCount + batchTotals.errors;

    const initialPending =
      (current?.metadata as any)?.pending?.total ??
      (current?.metadata as any)?.pendingTotal ??
      (remainingPending.total + totalFetched);
    const progressPct =
      typeof initialPending === "number" && initialPending > 0
        ? Math.min((totalFetched / initialPending) * 100, 100)
        : 0;

    const status = hasMore ? "running" : "completed";
    const nowIso = new Date().toISOString();

    const nextCheckpoint: Record<string, unknown> = {
      ...prevCheckpoint,
      chunk: nextChunk,
      runningTotal: totalFetched,
      progressPct,
      lastActivity: nowIso,
      errorCount,
      lastBatch: batchTotals,
      canResume: false,
    };

    await supabase
      .from("sync_runs")
      .update({
        status,
        completed_at: hasMore ? null : nowIso,
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        checkpoint: nextCheckpoint,
      })
      .eq("id", syncRunId!)
      // Don't override user cancellation.
      .in("status", ["running", "continuing", "paused"]);

    // Auto-chain the next chunk in the background.
    if (hasMore) {
      EdgeRuntime.waitUntil(
        (async () => {
          const chainRes = await invokeNextChunk({
            supabaseUrl,
            serviceRoleKey,
            syncRunId: syncRunId!,
            batchSize,
            sources,
            importId,
            chunk: nextChunk,
          });

          if (chainRes.ok) return;

          // If chaining fails consistently, pause so the UI can offer "Reanudar".
          await supabase
            .from("sync_runs")
            .update({
              status: "paused",
              error_message: `Chain fallo despues de 3 intentos en chunk ${nextChunk}. Haz clic en "Reanudar".`,
              checkpoint: {
                ...nextCheckpoint,
                canResume: true,
                chainFailed: true,
                lastActivity: new Date().toISOString(),
              },
            })
            .eq("id", syncRunId!)
            .in("status", ["running", "continuing"]);
        })(),
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status,
        syncRunId,
        hasMore,
        pending: pendingBefore,
        remainingPending,
        batch: batchTotals,
        totals: {
          fetched: totalFetched,
          inserted: totalInserted,
          updated: totalUpdated,
          skipped: totalSkipped,
          conflicts: totalConflicts,
          errors: errorCount,
        },
        progressPct,
        chunk: nextChunk,
        duration_ms: Date.now() - startedAt,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Fatal error in bulk-unify-contacts", error instanceof Error ? error : new Error(errorMessage));

    // Best-effort: mark run failed if we have an id.
    if (syncRunId) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, serviceRoleKey);
        await supabase
          .from("sync_runs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
          })
          .eq("id", syncRunId);
      } catch {
        // ignore
      }
    }

    return new Response(JSON.stringify({ ok: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
