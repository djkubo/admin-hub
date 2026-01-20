import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Declare EdgeRuntime for background processing
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

interface SyncRequest {
  dry_run?: boolean;
  batch_size?: number;
  checkpoint?: { cursor?: string; offset?: number };
  background?: boolean;
  continue_run_id?: string; // For auto-continuation
}

interface SyncStats {
  total_fetched: number;
  total_inserted: number;
  total_updated: number;
  total_skipped: number;
  total_conflicts: number;
  has_more: boolean;
  next_offset?: number;
  final_offset?: number;
}

// ============ BACKGROUND SYNC PROCESSOR ============
async function runGHLSync(
  supabase: SupabaseClient,
  ghlApiKey: string,
  ghlLocationId: string,
  syncRunId: string,
  dryRun: boolean,
  batchSize: number,
  initialOffset?: number,
  adminKey?: string
): Promise<SyncStats> {
  // Use offset-based pagination instead of cursor - more reliable for large datasets
  let offset = initialOffset || 0;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalConflicts = 0;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = 50; // Process 50 pages per invocation (100 contacts/page = 5000 per batch)
  // With auto-continuation, 150k contacts = ~30 continuation cycles (~30-60 mins total)

  try {
    while (hasMore && pageCount < maxPages) {
      pageCount++;
      console.log(`[sync-ghl] Page ${pageCount}, offset=${offset}`);

      // Use skip/limit pagination - more reliable than cursor for large datasets
      const ghlUrl = new URL(`https://services.leadconnectorhq.com/contacts/`);
      ghlUrl.searchParams.set('locationId', ghlLocationId);
      ghlUrl.searchParams.set('limit', batchSize.toString());
      ghlUrl.searchParams.set('skip', offset.toString());

      const ghlResponse = await fetch(ghlUrl.toString(), {
        headers: {
          'Authorization': `Bearer ${ghlApiKey}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });

      if (!ghlResponse.ok) {
        const errorText = await ghlResponse.text();
        console.error(`[sync-ghl] GHL API error: ${ghlResponse.status} - ${errorText}`);
        
        // Update sync run with error
        await supabase
          .from('sync_runs')
          .update({
            status: 'failed',
            error_message: `GHL API error: ${ghlResponse.status}`,
            completed_at: new Date().toISOString(),
            total_fetched: totalFetched,
            total_inserted: totalInserted,
            total_updated: totalUpdated,
            total_skipped: totalSkipped,
            total_conflicts: totalConflicts
          })
          .eq('id', syncRunId);
          
        throw new Error(`GHL API error: ${ghlResponse.status}`);
      }

      const ghlData = await ghlResponse.json();
      const contacts = ghlData.contacts || [];
      
      console.log(`[sync-ghl] Fetched ${contacts.length} contacts`);
      totalFetched += contacts.length;

      // Process contacts in parallel batches of 10
      const PARALLEL_SIZE = 10;
      for (let i = 0; i < contacts.length; i += PARALLEL_SIZE) {
        const batch = contacts.slice(i, i + PARALLEL_SIZE);
        const results = await Promise.all(
          batch.map(async (contact: Record<string, unknown>) => {
            try {
              if (!dryRun) {
                await supabase
                  .from('ghl_contacts_raw')
                  .upsert({
                    external_id: contact.id as string,
                    payload: contact,
                    sync_run_id: syncRunId,
                    fetched_at: new Date().toISOString()
                  }, { onConflict: 'external_id' });
              }

              const email = (contact.email as string) || null;
              const phone = (contact.phone as string) || (contact.phoneNumber as string) || null;
              const firstName = contact.firstName as string || '';
              const lastName = contact.lastName as string || '';
              const fullName = [firstName, lastName].filter(Boolean).join(' ') || (contact.name as string) || null;
              const tags = (contact.tags as string[]) || [];
              
              const dndSettings = contact.dndSettings as Record<string, { status?: string }> | undefined;
              const waOptIn = dndSettings?.whatsApp?.status !== 'active';
              const smsOptIn = dndSettings?.sms?.status !== 'active';
              const emailOptIn = dndSettings?.email?.status !== 'active';

              if (dryRun) {
                return { action: 'skipped' };
              }

              const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_contact', {
                p_source: 'ghl',
                p_external_id: contact.id as string,
                p_email: email,
                p_phone: phone,
                p_full_name: fullName,
                p_tags: tags,
                p_wa_opt_in: waOptIn,
                p_sms_opt_in: smsOptIn,
                p_email_opt_in: emailOptIn,
                p_extra_data: contact,
                p_dry_run: false,
                p_sync_run_id: syncRunId
              });

              if (mergeError) {
                console.error(`[sync-ghl] Merge error for ${contact.id}:`, mergeError.message);
                return { action: 'error' };
              }

              return { action: (mergeResult as { action?: string })?.action || 'none' };
              
            } catch (err) {
              console.error(`[sync-ghl] Contact error:`, err);
              return { action: 'error' };
            }
          })
        );

        for (const r of results) {
          if (r.action === 'inserted') totalInserted++;
          else if (r.action === 'updated') totalUpdated++;
          else if (r.action === 'conflict') totalConflicts++;
          else totalSkipped++;
        }
      }

      // Simple offset-based pagination - just advance by batch size
      if (contacts.length < batchSize) {
        hasMore = false;
        console.log(`[sync-ghl] Last page reached (got ${contacts.length} < ${batchSize})`);
      } else {
        offset += batchSize;
        console.log(`[sync-ghl] Offset advanced to: ${offset}`);
      }

      // Save checkpoint every page
      await supabase
        .from('sync_runs')
        .update({
          checkpoint: { offset },
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts
        })
        .eq('id', syncRunId);

      // Log progress every 5 pages
      if (pageCount % 5 === 0) {
        console.log(`[sync-ghl] Progress: ${totalFetched} fetched, ${totalInserted} inserted, ${totalUpdated} updated`);
      }
    }

    // If there's more data, schedule a continuation
    if (hasMore && adminKey) {
      console.log(`[sync-ghl] Scheduling continuation from offset ${offset}...`);
      
      // Update status to partial before continuing
      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts,
          checkpoint: { offset }
        })
        .eq('id', syncRunId);

      // Auto-continue by calling self with small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
      
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      try {
        const continueResponse = await fetch(`${supabaseUrl}/functions/v1/sync-ghl`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': adminKey
          },
          body: JSON.stringify({
            dry_run: dryRun,
            batch_size: batchSize,
            checkpoint: { offset },
            continue_run_id: syncRunId
          })
        });
        
        if (continueResponse.ok) {
          console.log(`[sync-ghl] Continuation triggered successfully`);
        } else {
          console.error(`[sync-ghl] Failed to trigger continuation: ${continueResponse.status}`);
        }
      } catch (continueError) {
        console.error(`[sync-ghl] Error triggering continuation:`, continueError);
      }

      return {
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        has_more: true,
        next_offset: offset
      };
    }

    // Final update - sync complete
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        checkpoint: { offset }
      })
      .eq('id', syncRunId);

    console.log(`[sync-ghl] COMPLETED: ${totalFetched} fetched, ${totalInserted} inserted, ${totalUpdated} updated, ${totalConflicts} conflicts`);

    return {
      total_fetched: totalFetched,
      total_inserted: totalInserted,
      total_updated: totalUpdated,
      total_skipped: totalSkipped,
      total_conflicts: totalConflicts,
      has_more: false,
      final_offset: offset
    };

  } catch (error) {
    console.error('[sync-ghl] Sync failed:', error);
    throw error;
  }
}

// ============ MAIN HANDLER ============
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // SECURITY: Verify x-admin-key
    const adminKey = Deno.env.get("ADMIN_API_KEY");
    const providedKey = req.headers.get("x-admin-key");
    
    if (!adminKey || !providedKey || providedKey !== adminKey) {
      console.error("❌ Auth failed");
      return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ error: 'GHL_API_KEY and GHL_LOCATION_ID secrets required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    
    let body: SyncRequest = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is OK
    }
    
    const dryRun = body.dry_run ?? false;
    const batchSize = Math.min(body.batch_size ?? 100, 100); // Default 100, max 100 (GHL API limit)
    const background = body.background ?? true;
    // Support both old cursor format and new offset format for backwards compatibility
    const offset = body.checkpoint?.offset ?? (body.checkpoint?.cursor ? 0 : 0);
    const continueRunId = (body as { continue_run_id?: string }).continue_run_id;

    // If continuing an existing run, use that ID instead of creating new
    let syncRunId: string;
    
    if (continueRunId) {
      console.log(`[sync-ghl] CONTINUING run ${continueRunId} from offset=${offset}`);
      syncRunId = continueRunId;
      
      // Update status to running
      await supabase
        .from('sync_runs')
        .update({ status: 'running' })
        .eq('id', syncRunId);
    } else {
      console.log(`[sync-ghl] Starting NEW sync, dry_run=${dryRun}, batch_size=${batchSize}, background=${background}`);

      // Create sync run
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'ghl',
          status: 'running',
          dry_run: dryRun,
          checkpoint: { offset: 0 }
        })
        .select()
        .single();

      if (syncError) {
        console.error('[sync-ghl] Failed to create sync run:', syncError);
        throw syncError;
      }

      syncRunId = syncRun.id;
    }

    // Background mode: return immediately
    if (background) {
      const syncTask = runGHLSync(
        supabase,
        ghlApiKey,
        ghlLocationId,
        syncRunId,
        dryRun,
        batchSize,
        offset,
        providedKey! // Pass admin key for auto-continuation
      );
      
      EdgeRuntime.waitUntil(syncTask);

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'background',
          sync_run_id: syncRunId,
          message: continueRunId 
            ? 'GHL sync continuing in background.' 
            : 'GHL sync started in background. Check sync_runs table for progress.',
          dry_run: dryRun
        }),
        { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Foreground mode: wait for completion
    const stats = await runGHLSync(
      supabase,
      ghlApiKey,
      ghlLocationId,
      syncRunId,
      dryRun,
      batchSize,
      offset,
      providedKey!
    );

    const duration = Date.now() - startTime;
    console.log(`[sync-ghl] Completed in ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'sync',
        sync_run_id: syncRunId,
        dry_run: dryRun,
        duration_ms: duration,
        stats
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[sync-ghl] Error:', error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
