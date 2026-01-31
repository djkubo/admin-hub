import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';
import { RATE_LIMITERS } from '../_shared/rate-limiter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('sync-ghl', LogLevel.INFO);
const rateLimiter = RATE_LIMITERS.GHL;

// ============ CONFIGURATION ============
const CONTACTS_PER_PAGE = 100;
const STALE_TIMEOUT_MINUTES = 5; // Reduced from 30 to 5 for faster recovery

// ============ VERIFY ADMIN ============
async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { valid: false, error: 'Invalid token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true, userId: user.id };
}

// ============ PROCESS SINGLE PAGE (STAGE ONLY MODE) ============
// This mode only saves raw data to ghl_contacts_raw without merging
async function processSinglePageStageOnly(
  supabase: ReturnType<typeof createClient>,
  ghlApiKey: string,
  ghlLocationId: string,
  syncRunId: string,
  startAfterId: string | null,
  startAfter: number | null
): Promise<{
  contactsFetched: number;
  staged: number;
  hasMore: boolean;
  nextStartAfterId: string | null;
  nextStartAfter: number | null;
  error: string | null;
}> {
  let staged = 0;

  try {
    const ghlUrl = 'https://services.leadconnectorhq.com/contacts/search';

    // GHL API v2 uses searchAfter array for pagination, NOT startAfterId in body
    const bodyParams: Record<string, unknown> = {
      locationId: ghlLocationId,
      pageLimit: CONTACTS_PER_PAGE
    };

    // searchAfter expects [timestamp, id] array format
    if (startAfter && startAfterId) {
      bodyParams.searchAfter = [startAfter, startAfterId];
      logger.info('Using searchAfter array for pagination', { startAfter, startAfterId });
    }

    const finalBody = JSON.stringify(bodyParams);
    
    logger.info('Fetching GHL contacts (STAGE ONLY MODE)', { 
      hasSearchAfter: !!(startAfter && startAfterId),
      limit: CONTACTS_PER_PAGE 
    });

    const ghlResponse = await retryWithBackoff(
      () => rateLimiter.execute(() =>
        fetch(ghlUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghlApiKey}`,
            'Version': '2021-07-28',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: finalBody
        })
      ),
      {
        ...RETRY_CONFIGS.STANDARD,
        retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.GHL, ...RETRYABLE_ERRORS.HTTP]
      }
    );

    if (!ghlResponse.ok) {
      const errorText = await ghlResponse.text();
      logger.error(`GHL API error: ${ghlResponse.status}`, new Error(errorText), { startAfterId });
      return {
        contactsFetched: 0,
        staged: 0,
        hasMore: false,
        nextStartAfterId: null,
        nextStartAfter: null,
        error: `GHL API error: ${ghlResponse.status} - ${errorText.substring(0, 300)}`
      };
    }

    const ghlData = await ghlResponse.json();
    const contacts = ghlData.contacts || [];

    logger.info('Fetched GHL contacts', { count: contacts.length, startAfterId });

    if (contacts.length === 0) {
      return {
        contactsFetched: 0,
        staged: 0,
        hasMore: false,
        nextStartAfterId: null,
        nextStartAfter: null,
        error: null
      };
    }

    // STAGE ONLY: Save raw contacts in batches without merging
    const BATCH_SIZE = 50;
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      
      const rawRecords = batch.map((contact: Record<string, unknown>) => ({
        external_id: contact.id as string,
        payload: contact,
        sync_run_id: syncRunId,
        fetched_at: new Date().toISOString(),
        processed_at: null // Will be set during unification
      }));

      // Try upsert first
      const { error: upsertError } = await supabase
        .from('ghl_contacts_raw')
        .upsert(rawRecords, { onConflict: 'external_id' });

      if (upsertError) {
        // Fallback: Delete existing and insert new if constraint error
        if (upsertError.message?.includes('ON CONFLICT') || upsertError.message?.includes('unique')) {
          logger.warn('Upsert failed, using delete+insert fallback', { error: upsertError.message });
          const externalIds = rawRecords.map((r: { external_id: string }) => r.external_id);
          await supabase.from('ghl_contacts_raw').delete().in('external_id', externalIds);
          const { error: insertError } = await supabase.from('ghl_contacts_raw').insert(rawRecords);
          if (insertError) {
            logger.error('Error inserting raw contacts batch (fallback)', insertError);
          } else {
            staged += batch.length;
          }
        } else {
          logger.error('Error upserting raw contacts batch', upsertError);
        }
      } else {
        staged += batch.length;
      }
    }

    // Determine pagination
    const hasMore = contacts.length >= CONTACTS_PER_PAGE;
    const lastContact = contacts[contacts.length - 1];
    const searchAfter = lastContact.searchAfter as [number, string] | undefined;
    
    let nextStartAfterId: string | null = null;
    let nextStartAfter: number | null = null;
    
    if (searchAfter && Array.isArray(searchAfter) && searchAfter.length >= 2) {
      nextStartAfter = searchAfter[0] as number;
      nextStartAfterId = searchAfter[1] as string;
    } else {
      nextStartAfterId = lastContact.id as string;
      nextStartAfter = lastContact.dateAdded ? new Date(lastContact.dateAdded as string).getTime() : null;
    }
    
    logger.info('Stage-only pagination info', { 
      hasMore, 
      staged,
      nextStartAfterId
    });

    return {
      contactsFetched: contacts.length,
      staged,
      hasMore,
      nextStartAfterId,
      nextStartAfter,
      error: null
    };

  } catch (error) {
    return {
      contactsFetched: 0,
      staged: 0,
      hasMore: false,
      nextStartAfterId: startAfterId,
      nextStartAfter: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// ============ PROCESS SINGLE PAGE (WITH MERGE - LEGACY) ============
async function processSinglePage(
  supabase: ReturnType<typeof createClient>,
  ghlApiKey: string,
  ghlLocationId: string,
  syncRunId: string,
  dryRun: boolean,
  startAfterId: string | null,
  startAfter: number | null
): Promise<{
  contactsFetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  conflicts: number;
  hasMore: boolean;
  nextStartAfterId: string | null;
  nextStartAfter: number | null;
  error: string | null;
}> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  try {
    const ghlUrl = 'https://services.leadconnectorhq.com/contacts/search';

    // GHL API v2 uses searchAfter array for pagination
    const bodyParams: Record<string, unknown> = {
      locationId: ghlLocationId,
      pageLimit: CONTACTS_PER_PAGE
    };

    // searchAfter expects [timestamp, id] array format
    if (startAfter && startAfterId) {
      bodyParams.searchAfter = [startAfter, startAfterId];
      logger.info('Using searchAfter array for pagination', { startAfter, startAfterId });
    }

    const finalBody = JSON.stringify(bodyParams);
    
    logger.info('Fetching GHL contacts (V2 Search)', { 
      hasSearchAfter: !!(startAfter && startAfterId),
      limit: CONTACTS_PER_PAGE,
      bodyPreview: finalBody.substring(0, 200)
    });

    const ghlResponse = await retryWithBackoff(
      () => rateLimiter.execute(() =>
        fetch(ghlUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghlApiKey}`,
            'Version': '2021-07-28',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: finalBody
        })
      ),
      {
        ...RETRY_CONFIGS.STANDARD,
        retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.GHL, ...RETRYABLE_ERRORS.HTTP]
      }
    );

    if (!ghlResponse.ok) {
      const errorText = await ghlResponse.text();
      logger.error(`GHL API error: ${ghlResponse.status}`, new Error(errorText), { startAfterId });
      return {
        contactsFetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        hasMore: false,
        nextStartAfterId: null,
        nextStartAfter: null,
        error: `GHL API error: ${ghlResponse.status} - ${errorText.substring(0, 300)}`
      };
    }

    const ghlData = await ghlResponse.json();
    const contacts = ghlData.contacts || [];

    logger.info('Fetched GHL contacts', { count: contacts.length, startAfterId });

    if (contacts.length === 0) {
      return {
        contactsFetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        hasMore: false,
        nextStartAfterId: null,
        nextStartAfter: null,
        error: null
      };
    }

    // Process contacts in parallel
    const PARALLEL_SIZE = 20;
    for (let i = 0; i < contacts.length; i += PARALLEL_SIZE) {
      // Check if sync was cancelled
      const { data: batchCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId)
        .single() as { data: { status: string } | null };
      
      if (batchCheck?.status === 'canceled' || batchCheck?.status === 'cancelled') {
        logger.info('Sync cancelled during batch processing', { syncRunId, batchIndex: i });
        break;
      }
      
      const batch = contacts.slice(i, i + PARALLEL_SIZE);
      const results = await Promise.all(
        batch.map(async (contact: Record<string, unknown>) => {
          try {
            const contactEmail = (contact.email as string) || null;
            const contactPhone = (contact.phone as string) || null;
            
            if (!contactEmail && !contactPhone) {
              logger.debug('Skipping contact without email or phone', { contactId: contact.id });
              return { action: 'skipped', reason: 'no_email_no_phone' };
            }

            // Save raw contact
            if (!dryRun) {
              await (supabase.from('ghl_contacts_raw') as ReturnType<typeof supabase.from>)
                .upsert({
                  external_id: contact.id as string,
                  payload: contact,
                  sync_run_id: syncRunId,
                  fetched_at: new Date().toISOString()
                }, { onConflict: 'external_id' });
            }

            const email = contactEmail;
            const phone = contactPhone;
            const firstName = (contact.firstName as string) || '';
            const lastName = (contact.lastName as string) || '';
            const fullName = (contact.contactName as string) || 
                           [firstName, lastName].filter(Boolean).join(' ') || 
                           null;
            const tags = (contact.tags as string[]) || [];
            const source = (contact.source as string) || 'ghl';
            const type = (contact.type as string) || 'lead';
            const dateAdded = contact.dateAdded ? new Date(contact.dateAdded as string).toISOString() : null;
            const dateUpdated = contact.dateUpdated ? new Date(contact.dateUpdated as string).toISOString() : null;
            
            const attributionSource = contact.attributionSource as Record<string, unknown> | undefined;
            const lastAttributionSource = contact.lastAttributionSource as Record<string, unknown> | undefined;

            const dndSettings = contact.dndSettings as Record<string, { status?: string }> | undefined;
            const inboundDndSettings = contact.inboundDndSettings as Record<string, { status?: string }> | undefined;
            const waOptIn = !contact.dnd && (dndSettings?.whatsApp?.status !== 'active' && inboundDndSettings?.whatsApp?.status !== 'active');
            const smsOptIn = !contact.dnd && (dndSettings?.sms?.status !== 'active' && inboundDndSettings?.sms?.status !== 'active');
            const emailOptIn = !contact.dnd && (dndSettings?.email?.status !== 'active' && inboundDndSettings?.email?.status !== 'active');

            if (dryRun) {
              return { action: 'skipped' };
            }

            const extraData = {
              ...contact,
              source: source,
              type: type,
              dateAdded: dateAdded,
              dateUpdated: dateUpdated,
              attributionSource: attributionSource,
              lastAttributionSource: lastAttributionSource,
              customFieldsArray: Array.isArray(contact.customFields) ? contact.customFields : []
            };

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
              p_extra_data: extraData,
              p_dry_run: false,
              p_sync_run_id: syncRunId
            });

            if (mergeError) {
              logger.error(`Merge error for ${contact.id}`, mergeError);
              return { action: 'error' };
            }

            return { action: (mergeResult as { action?: string })?.action || 'none' };

          } catch (err) {
            logger.error(`Contact error`, err instanceof Error ? err : new Error(String(err)));
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

    const hasMore = contacts.length >= CONTACTS_PER_PAGE;
    const lastContact = contacts[contacts.length - 1];
    const searchAfter = lastContact.searchAfter as [number, string] | undefined;
    
    let nextStartAfterId: string | null = null;
    let nextStartAfter: number | null = null;
    
    if (searchAfter && Array.isArray(searchAfter) && searchAfter.length >= 2) {
      nextStartAfter = searchAfter[0] as number;
      nextStartAfterId = searchAfter[1] as string;
    } else {
      nextStartAfterId = lastContact.id as string;
      nextStartAfter = lastContact.dateAdded ? new Date(lastContact.dateAdded as string).getTime() : null;
    }
    
    logger.info('Pagination info', { 
      hasMore, 
      contactsFetched: contacts.length, 
      nextStartAfterId, 
      nextStartAfter,
      searchAfter: searchAfter ? 'present' : 'missing'
    });

    return {
      contactsFetched: contacts.length,
      inserted,
      updated,
      skipped,
      conflicts,
      hasMore,
      nextStartAfterId,
      nextStartAfter,
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
      nextStartAfterId: startAfterId,
      nextStartAfter: null,
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
    // SECURITY: Verify JWT + is_admin()
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: authCheck.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ ok: false, error: 'GHL_API_KEY and GHL_LOCATION_ID secrets required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request
    let dryRun = false;
    let stageOnly = false; // NEW: Stage-only mode
    let testOnly = false; // TEST MODE: Just verify API connection
    let startAfterId: string | null = null;
    let startAfter: number | null = null;
    let syncRunId: string | null = null;
    let cleanupStale = false;
    let forceCancel = false;

    try {
      const body = await req.json();
      dryRun = body.dry_run ?? body.dryRun ?? false;
      stageOnly = body.stageOnly ?? false; // NEW
      testOnly = body.testOnly ?? false; // TEST MODE
      cleanupStale = body.cleanupStale === true;
      forceCancel = body.forceCancel === true;
      startAfterId = body.startAfterId || null;
      startAfter = body.startAfter || null;
      syncRunId = body.syncRunId || null;
    } catch {
      // Empty body is OK
    }

    // ============ TEST ONLY MODE - Just verify API connection ============
    if (testOnly) {
      logger.info('Test-only mode: Verifying GHL API connection');
      try {
        const testResponse = await fetch(
          `https://services.leadconnectorhq.com/locations/${ghlLocationId}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${ghlApiKey}`,
              'Version': '2021-07-28',
              'Accept': 'application/json'
            }
          }
        );
        
        const isOk = testResponse.ok;
        const statusCode = testResponse.status;
        
        logger.info('GHL API test result', { ok: isOk, status: statusCode });
        
        return new Response(
          JSON.stringify({
            ok: isOk,
            success: isOk,
            status: isOk ? 'connected' : 'error',
            apiStatus: statusCode,
            error: isOk ? null : `GHL API returned ${statusCode}`,
            testOnly: true
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (testError) {
        logger.error('GHL API test failed', testError instanceof Error ? testError : new Error(String(testError)));
        return new Response(
          JSON.stringify({
            ok: false,
            success: false,
            status: 'error',
            error: testError instanceof Error ? testError.message : 'Connection failed',
            testOnly: true
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ============ FORCE CANCEL ALL SYNCS ============
    if (forceCancel) {
      const { data: cancelledSyncs, error: cancelError } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(), 
          error_message: 'Cancelado forzosamente por usuario' 
        })
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .select('id');

      logger.info('Force cancelled GHL syncs', { count: cancelledSyncs?.length || 0, error: cancelError });

      return new Response(
        JSON.stringify({ 
          ok: true,
          success: true, 
          status: 'cancelled', 
          cancelled: cancelledSyncs?.length || 0,
          message: `Se cancelaron ${cancelledSyncs?.length || 0} sincronizaciones de GHL` 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ CLEANUP STALE SYNCS ============
    if (cleanupStale) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      const { data: staleSyncs } = await supabase
        .from('sync_runs')
        .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout - stale' })
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .lt('started_at', staleThreshold)
        .select('id');
      return new Response(JSON.stringify({ ok: true, cleaned: staleSyncs?.length || 0 }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ============ CHECK FOR EXISTING SYNC ============
    if (!syncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      // Clean stale first
      await supabase.from('sync_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout' })
        .eq('source', 'ghl').in('status', ['running', 'continuing']).lt('started_at', staleThreshold);

      const { data: existingRuns } = await supabase.from('sync_runs').select('id').eq('source', 'ghl').in('status', ['running', 'continuing']).limit(1);
      if (existingRuns && existingRuns.length > 0) {
        return new Response(JSON.stringify({ ok: false, status: 'already_running', error: 'Sync in progress', syncRunId: existingRuns[0].id }), { status: 409, headers: corsHeaders });
      }
    }

    // Create sync run if needed
    if (!syncRunId) {
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .insert({ 
          source: 'ghl', 
          status: 'running', 
          dry_run: dryRun, 
          checkpoint: { startAfterId: null },
          metadata: { stageOnly } // Track mode
        })
        .select('id').single();
      syncRunId = syncRun?.id;
    } else {
      await supabase.from('sync_runs').update({ status: 'running', checkpoint: { startAfterId, lastActivity: new Date().toISOString() } }).eq('id', syncRunId);
    }

    // ============ CHECK IF CANCELLED BEFORE PROCESSING ============
    const { data: syncCheck } = await supabase
      .from('sync_runs')
      .select('status')
      .eq('id', syncRunId!)
      .single();
    
    if (syncCheck?.status === 'canceled' || syncCheck?.status === 'cancelled') {
      logger.info('Sync was cancelled, stopping', { syncRunId });
      return new Response(
        JSON.stringify({ ok: false, status: 'canceled', error: 'Sync was cancelled by user' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ PROCESS PAGE ============
    const pageStartTime = Date.now();
    logger.info(`Processing GHL page`, { startAfterId, syncRunId, stageOnly });

    if (stageOnly) {
      // NEW: Stage-only mode - just download, no merge
      const pageResult = await processSinglePageStageOnly(
        supabase as ReturnType<typeof createClient>,
        ghlApiKey,
        ghlLocationId,
        syncRunId!,
        startAfterId,
        startAfter
      );
      
      const pageDuration = Date.now() - pageStartTime;
      logger.info(`GHL page staged`, { 
        duration_ms: pageDuration,
        contactsFetched: pageResult.contactsFetched,
        staged: pageResult.staged
      });

      if (pageResult.error) {
        await supabase.from('sync_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: pageResult.error }).eq('id', syncRunId);
        return new Response(JSON.stringify({ ok: false, error: pageResult.error }), { status: 500, headers: corsHeaders });
      }

      if (pageResult.hasMore) {
        await supabase
          .from('sync_runs')
          .update({
            status: 'continuing',
            total_fetched: pageResult.contactsFetched,
            total_inserted: pageResult.staged,
            checkpoint: {
              startAfterId: pageResult.nextStartAfterId,
              startAfter: pageResult.nextStartAfter,
              lastActivity: new Date().toISOString()
            }
          })
          .eq('id', syncRunId);

        return new Response(
          JSON.stringify({
            ok: true,
            status: 'continuing',
            syncRunId,
            processed: pageResult.contactsFetched,
            staged: pageResult.staged,
            hasMore: true,
            nextStartAfterId: pageResult.nextStartAfterId,
            nextStartAfter: pageResult.nextStartAfter,
            stageOnly: true
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Staging complete
      await supabase
        .from('sync_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          total_fetched: pageResult.contactsFetched,
          total_inserted: pageResult.staged,
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ 
          ok: true, 
          status: 'completed', 
          syncRunId, 
          processed: pageResult.contactsFetched, 
          staged: pageResult.staged,
          hasMore: false,
          stageOnly: true,
          message: 'Staging complete. Run unify-all-sources to merge into clients.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // LEGACY: Full merge mode
    const pageResult = await processSinglePage(
      supabase as ReturnType<typeof createClient>,
      ghlApiKey,
      ghlLocationId,
      syncRunId!,
      dryRun,
      startAfterId,
      startAfter
    );
    
    // Check if cancelled after processing
    const { data: syncCheckAfter } = await supabase
      .from('sync_runs')
      .select('status')
      .eq('id', syncRunId!)
      .single();
    
    if (syncCheckAfter?.status === 'canceled' || syncCheckAfter?.status === 'cancelled') {
      logger.info('Sync was cancelled after page processing', { syncRunId });
      await supabase.from('sync_runs').update({ 
        status: 'cancelled', 
        completed_at: new Date().toISOString(),
        error_message: 'Cancelled by user during processing'
      }).eq('id', syncRunId);
      return new Response(
        JSON.stringify({ ok: false, status: 'canceled', error: 'Sync was cancelled by user' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const pageDuration = Date.now() - pageStartTime;
    logger.info(`GHL page processed`, { 
      duration_ms: pageDuration,
      contactsFetched: pageResult.contactsFetched,
      inserted: pageResult.inserted,
      updated: pageResult.updated,
      skipped: pageResult.skipped,
      conflicts: pageResult.conflicts,
      contactsPerSecond: pageResult.contactsFetched > 0 ? (pageResult.contactsFetched / (pageDuration / 1000)).toFixed(2) : 0
    });

    if (pageResult.error) {
      await supabase.from('sync_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: pageResult.error }).eq('id', syncRunId);
      return new Response(JSON.stringify({ ok: false, error: pageResult.error }), { status: 500, headers: corsHeaders });
    }

    if (pageResult.hasMore) {
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
            startAfterId: pageResult.nextStartAfterId,
            startAfter: pageResult.nextStartAfter,
            lastActivity: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({
          ok: true,
          status: 'continuing',
          syncRunId,
          processed: pageResult.contactsFetched,
          hasMore: true,
          nextStartAfterId: pageResult.nextStartAfterId,
          nextStartAfter: pageResult.nextStartAfter
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Sync complete
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
      })
      .eq('id', syncRunId);

    return new Response(
      JSON.stringify({ ok: true, status: 'completed', syncRunId, processed: pageResult.contactsFetched, hasMore: false }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Fatal error", error instanceof Error ? error : new Error(String(error)));
    
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
