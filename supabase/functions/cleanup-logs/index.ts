import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CleanupResult {
  sync_runs_deleted: number;
  csv_import_runs_deleted: number;
  csv_imports_raw_deleted: number;
  ghl_contacts_raw_deleted: number;
  manychat_contacts_raw_deleted: number;
  merge_conflicts_deleted: number;
  errors: string[];
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  console.log("[cleanup-logs] Starting cleanup process...");

  const result: CleanupResult = {
    sync_runs_deleted: 0,
    csv_import_runs_deleted: 0,
    csv_imports_raw_deleted: 0,
    ghl_contacts_raw_deleted: 0,
    manychat_contacts_raw_deleted: 0,
    merge_conflicts_deleted: 0,
    errors: [],
  };

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoffDate = sevenDaysAgo.toISOString();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const rawCutoffDate = thirtyDaysAgo.toISOString();

  try {
    // ============================================
    // 1. CLEANUP sync_runs - Keep last successful per source
    // ============================================
    console.log("[cleanup-logs] Cleaning sync_runs older than 7 days...");

    // First, get the IDs of the last successful run per source (to preserve)
    const { data: lastSuccessful, error: lastSuccessfulError } = await supabase
      .from("sync_runs")
      .select("id, source")
      .eq("status", "completed")
      .order("started_at", { ascending: false });

    if (lastSuccessfulError) {
      console.error("[cleanup-logs] Error fetching last successful runs:", lastSuccessfulError);
      result.errors.push(`sync_runs fetch error: ${lastSuccessfulError.message}`);
    }

    // Get unique last successful ID per source
    const preserveIds = new Set<string>();
    const seenSources = new Set<string>();
    
    if (lastSuccessful) {
      for (const run of lastSuccessful) {
        if (!seenSources.has(run.source)) {
          seenSources.add(run.source);
          preserveIds.add(run.id);
          console.log(`[cleanup-logs] Preserving last successful run for ${run.source}: ${run.id}`);
        }
      }
    }

    // Delete old sync_runs except preserved ones
    const { data: deletedSyncRuns, error: syncRunsError } = await supabase
      .from("sync_runs")
      .delete()
      .lt("started_at", cutoffDate)
      .not("id", "in", `(${Array.from(preserveIds).join(",")})`)
      .select("id");

    if (syncRunsError) {
      console.error("[cleanup-logs] Error deleting sync_runs:", syncRunsError);
      result.errors.push(`sync_runs delete error: ${syncRunsError.message}`);
    } else {
      result.sync_runs_deleted = deletedSyncRuns?.length || 0;
      console.log(`[cleanup-logs] Deleted ${result.sync_runs_deleted} sync_runs`);
    }

    // ============================================
    // 2. CLEANUP csv_import_runs (completed ones older than 30 days)
    // ============================================
    console.log("[cleanup-logs] Cleaning csv_import_runs older than 30 days...");

    // First delete related csv_imports_raw records
    const { data: oldImportRuns } = await supabase
      .from("csv_import_runs")
      .select("id")
      .lt("started_at", rawCutoffDate)
      .in("status", ["completed", "failed"]);

    if (oldImportRuns && oldImportRuns.length > 0) {
      const oldImportIds = oldImportRuns.map(r => r.id);

      // Delete raw import data first (FK constraint)
      const { data: deletedRaw, error: rawError } = await supabase
        .from("csv_imports_raw")
        .delete()
        .in("import_id", oldImportIds)
        .select("id");

      if (rawError) {
        console.error("[cleanup-logs] Error deleting csv_imports_raw:", rawError);
        result.errors.push(`csv_imports_raw delete error: ${rawError.message}`);
      } else {
        result.csv_imports_raw_deleted = deletedRaw?.length || 0;
        console.log(`[cleanup-logs] Deleted ${result.csv_imports_raw_deleted} csv_imports_raw`);
      }

      // Now delete the import runs
      const { data: deletedImportRuns, error: importRunsError } = await supabase
        .from("csv_import_runs")
        .delete()
        .in("id", oldImportIds)
        .select("id");

      if (importRunsError) {
        console.error("[cleanup-logs] Error deleting csv_import_runs:", importRunsError);
        result.errors.push(`csv_import_runs delete error: ${importRunsError.message}`);
      } else {
        result.csv_import_runs_deleted = deletedImportRuns?.length || 0;
        console.log(`[cleanup-logs] Deleted ${result.csv_import_runs_deleted} csv_import_runs`);
      }
    }

    // ============================================
    // 3. CLEANUP ghl_contacts_raw (processed ones older than 30 days)
    // ============================================
    console.log("[cleanup-logs] Cleaning ghl_contacts_raw older than 30 days...");

    const { data: deletedGhl, error: ghlError } = await supabase
      .from("ghl_contacts_raw")
      .delete()
      .lt("fetched_at", rawCutoffDate)
      .not("processed_at", "is", null)
      .select("id");

    if (ghlError) {
      console.error("[cleanup-logs] Error deleting ghl_contacts_raw:", ghlError);
      result.errors.push(`ghl_contacts_raw delete error: ${ghlError.message}`);
    } else {
      result.ghl_contacts_raw_deleted = deletedGhl?.length || 0;
      console.log(`[cleanup-logs] Deleted ${result.ghl_contacts_raw_deleted} ghl_contacts_raw`);
    }

    // ============================================
    // 4. CLEANUP manychat_contacts_raw (processed ones older than 30 days)
    // ============================================
    console.log("[cleanup-logs] Cleaning manychat_contacts_raw older than 30 days...");

    const { data: deletedManychat, error: manychatError } = await supabase
      .from("manychat_contacts_raw")
      .delete()
      .lt("fetched_at", rawCutoffDate)
      .not("processed_at", "is", null)
      .select("id");

    if (manychatError) {
      console.error("[cleanup-logs] Error deleting manychat_contacts_raw:", manychatError);
      result.errors.push(`manychat_contacts_raw delete error: ${manychatError.message}`);
    } else {
      result.manychat_contacts_raw_deleted = deletedManychat?.length || 0;
      console.log(`[cleanup-logs] Deleted ${result.manychat_contacts_raw_deleted} manychat_contacts_raw`);
    }

    // ============================================
    // 5. CLEANUP merge_conflicts (resolved ones older than 30 days)
    // ============================================
    console.log("[cleanup-logs] Cleaning resolved merge_conflicts older than 30 days...");

    const { data: deletedConflicts, error: conflictsError } = await supabase
      .from("merge_conflicts")
      .delete()
      .lt("created_at", rawCutoffDate)
      .eq("status", "resolved")
      .select("id");

    if (conflictsError) {
      console.error("[cleanup-logs] Error deleting merge_conflicts:", conflictsError);
      result.errors.push(`merge_conflicts delete error: ${conflictsError.message}`);
    } else {
      result.merge_conflicts_deleted = deletedConflicts?.length || 0;
      console.log(`[cleanup-logs] Deleted ${result.merge_conflicts_deleted} merge_conflicts`);
    }

    const totalDeleted = 
      result.sync_runs_deleted +
      result.csv_import_runs_deleted +
      result.csv_imports_raw_deleted +
      result.ghl_contacts_raw_deleted +
      result.manychat_contacts_raw_deleted +
      result.merge_conflicts_deleted;

    console.log(`[cleanup-logs] Cleanup complete. Total records deleted: ${totalDeleted}`);

    return new Response(
      JSON.stringify({
        success: result.errors.length === 0,
        message: `Cleanup complete. Deleted ${totalDeleted} records.`,
        details: result,
        preserved_sources: Array.from(seenSources),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[cleanup-logs] Unexpected error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
        details: result,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
