import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

// ============ CONFIGURATION ============
const CONTACTS_PER_PAGE = 100;
const STALE_TIMEOUT_MINUTES = 30;

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
    let dryRun = false;
    let offset = 0;
    let syncRunId: string | null = null;
    let cleanupStale = false;
    
    try {
      const body = await req.json();
      dryRun = body.dry_run ?? false;
      cleanupStale = body.cleanupStale === true;
      offset = body.offset || 0;
      syncRunId = body.syncRunId || null;
    } catch {
      // Empty body is OK
    }

    // ============ CLEANUP STALE SYNCS ============
    if (cleanupStale) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      const { data: staleSyncs } = await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Timeout - sin actividad por 30 minutos'
        })
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold)
        .select('id');
      
      return new Response(
        JSON.stringify({ success: true, cleaned: staleSyncs?.length || 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ CHECK FOR EXISTING SYNC ============
    if (!syncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      
      // Mark stale syncs as failed
      await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Timeout - sin actividad por 30 minutos'
        })
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold);

      // Check for existing active sync
      const { data: existingRuns } = await supabase
        .from('sync_runs')
        .select('id')
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .limit(1);

      if (existingRuns && existingRuns.length > 0) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'sync_already_running',
            message: 'Ya hay un sync de GHL en progreso',
            existingSyncId: existingRuns[0].id
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Create sync run if needed
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'ghl',
          status: 'running',
          dry_run: dryRun,
          checkpoint: { offset: 0 }
        })
        .select('id')
        .single();

      if (syncError) {
        return new Response(
          JSON.stringify({ error: 'Failed to create sync record' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      syncRunId = syncRun?.id;
      console.log(`📊 NEW GHL SYNC RUN: ${syncRunId}`);
    } else {
      // Update activity
      await supabase
        .from('sync_runs')
        .update({ 
          status: 'running',
          checkpoint: { offset, lastActivity: new Date().toISOString() }
        })
        .eq('id', syncRunId);
    }

    // ============ PROCESS SINGLE PAGE ============
    console.log(`📄 Processing GHL page, offset: ${offset}...`);

    const pageResult = await processSinglePage(
      supabase as any,
      ghlApiKey,
      ghlLocationId,
      syncRunId!,
      dryRun,
      offset
    );

    // Handle errors
    if (pageResult.error) {
      console.error(`❌ GHL sync failed:`, pageResult.error);
      
      await supabase
        .from('sync_runs')
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
          syncRunId
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`✅ GHL page: ${pageResult.contactsFetched} contacts, ${pageResult.inserted} inserted`);

    // ============ CHECK IF MORE PAGES ============
    const hasMore = pageResult.hasMore;

    if (hasMore) {
      // Update checkpoint - frontend will call again with new offset
      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: pageResult.contactsFetched,
          total_inserted: pageResult.inserted,
          total_updated: pageResult.updated,
          total_skipped: pageResult.skipped,
          total_conflicts: pageResult.conflicts,
          checkpoint: { 
            offset: pageResult.nextOffset,
            lastActivity: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({
          success: true,
          status: 'continuing',
          syncRunId,
          contactsFetched: pageResult.contactsFetched,
          inserted: pageResult.inserted,
          updated: pageResult.updated,
          hasMore: true,
          nextOffset: pageResult.nextOffset,
          duration_ms: Date.now() - startTime
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ SYNC COMPLETE ============
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: pageResult.contactsFetched,
        total_inserted: pageResult.inserted,
        total_updated: pageResult.updated,
        total_skipped: pageResult.skipped,
        total_conflicts: pageResult.conflicts,
        checkpoint: null
      })
      .eq('id', syncRunId);

    console.log(`🎉 GHL SYNC COMPLETE: ${pageResult.contactsFetched} contacts in ${Date.now() - startTime}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        syncRunId,
        stats: {
          total_fetched: pageResult.contactsFetched,
          total_inserted: pageResult.inserted,
          total_updated: pageResult.updated,
          total_skipped: pageResult.skipped,
          total_conflicts: pageResult.conflicts
        },
        hasMore: false,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error("Fatal error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
