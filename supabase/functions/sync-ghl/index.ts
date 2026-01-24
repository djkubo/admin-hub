import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

interface SyncRequest {
  dry_run?: boolean;
  batch_size?: number;
  max_pages?: number;
  _continuation?: {
    syncRunId: string;
    offset: number;
    pageNumber: number;
    totalFetched: number;
    totalInserted: number;
    totalUpdated: number;
    totalSkipped: number;
    totalConflicts: number;
  };
}

// ============ CONFIGURATION ============
const CONTACTS_PER_PAGE = 100;
const STALE_TIMEOUT_MINUTES = 30;

// ============ TRIGGER NEXT PAGE (BLOCKING) ============
async function triggerNextPage(
  supabaseUrl: string,
  adminKey: string,
  body: SyncRequest
): Promise<boolean> {
  try {
    console.log(`🚀 TRIGGERING GHL NEXT PAGE...`);
    const response = await fetch(`${supabaseUrl}/functions/v1/sync-ghl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey,
      },
      body: JSON.stringify(body),
    });
    console.log(`✅ GHL next page triggered: ${response.status}`);
    return response.ok || response.status === 202;
  } catch (err) {
    console.error(`❌ Failed to trigger GHL next page:`, err);
    return false;
  }
}

// ============ PROCESS SINGLE PAGE ============
async function processSinglePage(
  supabase: ReturnType<typeof createClient>,
  ghlApiKey: string,
  ghlLocationId: string,
  syncRunId: string,
  dryRun: boolean,
  offset: number
): Promise<{
  contactsFetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  conflicts: number;
  hasMore: boolean;
  nextOffset: number;
  error: string | null;
}> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  try {
    // Build GHL API URL
    const ghlUrl = new URL(`https://services.leadconnectorhq.com/contacts/`);
    ghlUrl.searchParams.set('locationId', ghlLocationId);
    ghlUrl.searchParams.set('limit', CONTACTS_PER_PAGE.toString());
    ghlUrl.searchParams.set('skip', offset.toString());

    console.log(`📡 GHL API: offset=${offset}`);

    const ghlResponse = await fetch(ghlUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${ghlApiKey}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    if (!ghlResponse.ok) {
      const errorText = await ghlResponse.text();
      console.error(`GHL API error: ${ghlResponse.status} - ${errorText}`);
      return {
        contactsFetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        hasMore: false,
        nextOffset: offset,
        error: `GHL API error: ${ghlResponse.status}`
      };
    }

    const ghlData = await ghlResponse.json();
    const contacts = ghlData.contacts || [];
    
    console.log(`📦 Fetched ${contacts.length} contacts`);

    if (contacts.length === 0) {
      return {
        contactsFetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        hasMore: false,
        nextOffset: offset,
        error: null
      };
    }

    // Process contacts - batch of 10 in parallel
    const PARALLEL_SIZE = 10;
    for (let i = 0; i < contacts.length; i += PARALLEL_SIZE) {
      const batch = contacts.slice(i, i + PARALLEL_SIZE);
      const results = await Promise.all(
        batch.map(async (contact: Record<string, unknown>) => {
          try {
            // Save raw contact
            if (!dryRun) {
              await (supabase.from('ghl_contacts_raw') as any)
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

            const { data: mergeResult, error: mergeError } = await (supabase as any).rpc('merge_contact', {
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
              console.error(`Merge error for ${contact.id}:`, mergeError.message);
              return { action: 'error' };
            }

            return { action: (mergeResult as { action?: string })?.action || 'none' };
            
          } catch (err) {
            console.error(`Contact error:`, err);
            return { action: 'error' };
          }
        })
      );

      for (const r of results) {
        if (r.action === 'inserted') inserted++;
        else if (r.action === 'updated') updated++;
        else if (r.action === 'conflict') conflicts++;
        else skipped++;
      }
    }

    // Determine if more pages
    const hasMore = contacts.length >= CONTACTS_PER_PAGE;
    const nextOffset = offset + contacts.length;

    return {
      contactsFetched: contacts.length,
      inserted,
      updated,
      skipped,
      conflicts,
      hasMore,
      nextOffset,
      error: null
    };

  } catch (error) {
    return {
      contactsFetched: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      conflicts: 0,
      hasMore: false,
      nextOffset: offset,
      error: error instanceof Error ? error.message : String(error)
    };
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
    
    // Parse request
    let body: SyncRequest = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is OK
    }
    
    const dryRun = body.dry_run ?? false;
    const maxPages = body.max_pages ?? 5000;

    // Continuation state
    let syncRunId: string | null = body._continuation?.syncRunId || null;
    let offset = body._continuation?.offset || 0;
    let pageNumber = body._continuation?.pageNumber || 0;
    let totalFetched = body._continuation?.totalFetched || 0;
    let totalInserted = body._continuation?.totalInserted || 0;
    let totalUpdated = body._continuation?.totalUpdated || 0;
    let totalSkipped = body._continuation?.totalSkipped || 0;
    let totalConflicts = body._continuation?.totalConflicts || 0;

    // ============ CHECK FOR EXISTING RUNNING/CONTINUING SYNC ============
    if (!syncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      // Check for existing active sync
      const { data: existingRuns } = await supabase
        .from('sync_runs')
        .select('id, status, started_at, checkpoint')
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .order('started_at', { ascending: false })
        .limit(1);

      if (existingRuns && existingRuns.length > 0) {
        const existingRun = existingRuns[0];
        
        // Check if stale
        if (existingRun.started_at < staleThreshold) {
          console.log(`⏰ Marking stale GHL sync ${existingRun.id} as failed`);
          await supabase
            .from('sync_runs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: 'Stale/timeout - no heartbeat for 30 minutes'
            })
            .eq('id', existingRun.id);
        } else {
          // Resume existing sync instead of creating new one
          console.log(`📍 Resuming existing GHL sync ${existingRun.id}`);
          const checkpoint = existingRun.checkpoint as Record<string, unknown> || {};
          syncRunId = existingRun.id;
          offset = (checkpoint.offset as number) || 0;
          pageNumber = (checkpoint.page as number) || 0;
          totalFetched = (checkpoint.totalFetched as number) || 0;
          totalInserted = (checkpoint.totalInserted as number) || 0;
          totalUpdated = (checkpoint.totalUpdated as number) || 0;
          totalSkipped = (checkpoint.totalSkipped as number) || 0;
          totalConflicts = (checkpoint.totalConflicts as number) || 0;
        }
      }
    }

    // Create or reuse sync_run
    if (!syncRunId) {
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
        console.error('Failed to create sync run:', syncError);
        return new Response(
          JSON.stringify({ error: 'Failed to create sync record' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      syncRunId = syncRun.id;
      console.log(`📊 NEW GHL SYNC RUN: ${syncRunId}`);
    } else {
      console.log(`🔄 CONTINUATION: Page ${pageNumber}, offset: ${offset}`);
    }

    // ============ PROCESS SINGLE PAGE ============
    console.log(`📄 Processing GHL page ${pageNumber + 1}...`);

    const pageResult = await processSinglePage(
      supabase as any,
      ghlApiKey,
      ghlLocationId,
      syncRunId!,
      dryRun,
      offset
    );

    // Update totals
    totalFetched += pageResult.contactsFetched;
    totalInserted += pageResult.inserted;
    totalUpdated += pageResult.updated;
    totalSkipped += pageResult.skipped;
    totalConflicts += pageResult.conflicts;
    pageNumber++;

    // Handle errors
    if (pageResult.error) {
      console.error(`❌ GHL Page ${pageNumber} failed:`, pageResult.error);
      
      // Log error but DON'T stop - continue to next page if possible
      await (supabase.from('sync_runs') as any)
        .update({
          checkpoint: { 
            offset: pageResult.nextOffset, 
            page: pageNumber,
            totalFetched,
            totalInserted,
            totalUpdated,
            totalSkipped,
            totalConflicts,
            last_error: pageResult.error,
            lastHeartbeat: new Date().toISOString()
          },
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts
        })
        .eq('id', syncRunId);
      
      // If it's a fatal API error, mark as failed
      if (pageResult.error.includes('API error')) {
        await (supabase.from('sync_runs') as any)
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: pageResult.error
          })
          .eq('id', syncRunId);
        
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: pageResult.error,
            syncRunId,
            page: pageNumber,
            totalFetched 
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log(`✅ GHL Page ${pageNumber}: ${pageResult.contactsFetched} contacts, ${pageResult.inserted} inserted`);

    // ============ DECIDE: CONTINUE OR COMPLETE ============
    const needsContinuation = pageResult.hasMore && pageNumber < maxPages;

    if (needsContinuation) {
      // Update checkpoint with heartbeat
      await (supabase.from('sync_runs') as any)
        .update({
          status: 'continuing',
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts,
          checkpoint: { 
            offset: pageResult.nextOffset, 
            page: pageNumber,
            totalFetched,
            totalInserted,
            totalUpdated,
            totalSkipped,
            totalConflicts,
            lastHeartbeat: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      // ============ CRITICAL: TRIGGER NEXT PAGE BEFORE RETURNING ============
      const triggered = await triggerNextPage(supabaseUrl, adminKey, {
        dry_run: dryRun,
        max_pages: maxPages,
        _continuation: {
          syncRunId: syncRunId!,
          offset: pageResult.nextOffset,
          pageNumber,
          totalFetched,
          totalInserted,
          totalUpdated,
          totalSkipped,
          totalConflicts
        }
      });

      if (!triggered) {
        await (supabase.from('sync_runs') as any)
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Failed to trigger next page continuation'
          })
          .eq('id', syncRunId);
      }

      const duration = Date.now() - startTime;
      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          sync_run_id: syncRunId,
          page: pageNumber,
          totalFetched,
          totalInserted,
          totalUpdated,
          hasMore: true,
          duration_ms: duration,
          message: `GHL Page ${pageNumber} complete. Next page triggered.`
        }),
        { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ SYNC COMPLETE ============
    await (supabase.from('sync_runs') as any)
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        checkpoint: { offset: pageResult.nextOffset, page: pageNumber }
      })
      .eq('id', syncRunId);

    const duration = Date.now() - startTime;
    console.log(`🎉 GHL SYNC COMPLETE: ${totalFetched} contacts, ${totalInserted} inserted, ${pageNumber} pages in ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        sync_run_id: syncRunId,
        dry_run: dryRun,
        pages: pageNumber,
        totalFetched,
        totalInserted,
        totalUpdated,
        totalSkipped,
        totalConflicts,
        hasMore: false,
        duration_ms: duration
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[sync-ghl] Fatal error:', error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
