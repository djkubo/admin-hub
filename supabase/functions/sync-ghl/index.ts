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
const STALE_TIMEOUT_MINUTES = 30;

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

// ============ PROCESS SINGLE PAGE ============
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

    // Construct pagination params strictly according to V2 docs
    // NOTE: 'checks' parameter is NOT valid in API v2.0 - DO NOT INCLUDE
    const bodyParams: Record<string, unknown> = {
      locationId: ghlLocationId,
      pageLimit: CONTACTS_PER_PAGE
    };

    // Pagination logic for GHL API v2.0
    // The API uses startAfterId (contact ID) for pagination
    // We can also use startAfter (timestamp) as alternative
    if (startAfterId) {
      bodyParams.startAfterId = startAfterId;
      logger.info('Using startAfterId for pagination', { startAfterId });
    } else if (startAfter) {
      bodyParams.startAfter = startAfter;
      logger.info('Using startAfter (timestamp) for pagination', { startAfter });
    }

    // Ensure bodyParams does NOT contain 'checks' - explicitly remove if present
    const { checks, ...cleanBodyParams } = bodyParams as any;
    if (checks !== undefined) {
      logger.warn('WARNING: checks parameter was present and removed!', { originalBody: bodyParams });
    }
    
    const finalBody = JSON.stringify(cleanBodyParams);
    logger.info('Fetching GHL contacts (V2 Search)', { 
      startAfterId, 
      limit: CONTACTS_PER_PAGE,
      bodyKeys: Object.keys(cleanBodyParams),
      bodyPreview: finalBody.substring(0, 200)
    });

    // Wrap API call with retry + rate limiting
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

    // Process contacts - batch of 20 in parallel for better throughput
    // Increased from 10 to 20 to speed up processing
    const PARALLEL_SIZE = 20;
    for (let i = 0; i < contacts.length; i += PARALLEL_SIZE) {
      // Check if sync was cancelled before processing each batch
      const { data: batchCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId)
        .single() as { data: { status: string } | null };
      
      if (batchCheck?.status === 'canceled' || batchCheck?.status === 'cancelled') {
        logger.info('Sync cancelled during batch processing', { syncRunId, batchIndex: i });
        break; // Stop processing batches
      }
      
      const batch = contacts.slice(i, i + PARALLEL_SIZE);
      const results = await Promise.all(
        batch.map(async (contact: Record<string, unknown>) => {
          try {
            // Skip contacts without email AND phone (can't merge without identifier)
            const contactEmail = (contact.email as string) || null;
            const contactPhone = (contact.phone as string) || null;
            
            if (!contactEmail && !contactPhone) {
              logger.debug('Skipping contact without email or phone', { contactId: contact.id });
              return { action: 'skipped', reason: 'no_email_no_phone' };
            }

            // Save raw contact for audit trail
            if (!dryRun) {
              await (supabase.from('ghl_contacts_raw') as any)
                .upsert({
                  external_id: contact.id as string,
                  payload: contact,
                  sync_run_id: syncRunId,
                  fetched_at: new Date().toISOString()
                }, { onConflict: 'external_id' });
            }

            // Extract contact data - using actual API structure
            const email = contactEmail;
            const phone = contactPhone;
            const firstName = (contact.firstName as string) || '';
            const lastName = (contact.lastName as string) || '';
            // Use contactName if available (it's the full name in lowercase), otherwise construct from firstName/lastName
            const fullName = (contact.contactName as string) || 
                           [firstName, lastName].filter(Boolean).join(' ') || 
                           null;
            const tags = (contact.tags as string[]) || [];
            const source = (contact.source as string) || 'ghl';
            const type = (contact.type as string) || 'lead';
            const dateAdded = contact.dateAdded ? new Date(contact.dateAdded as string).toISOString() : null;
            const dateUpdated = contact.dateUpdated ? new Date(contact.dateUpdated as string).toISOString() : null;
            
            // Extract attribution data if available
            const attributionSource = contact.attributionSource as Record<string, unknown> | undefined;
            const lastAttributionSource = contact.lastAttributionSource as Record<string, unknown> | undefined;

            // DND settings - check if contact has opted out
            const dndSettings = contact.dndSettings as Record<string, { status?: string }> | undefined;
            const inboundDndSettings = contact.inboundDndSettings as Record<string, { status?: string }> | undefined;
            // Opt-in logic: if dnd is false, they're opted in; if dndSettings has status 'active', they're opted out
            const waOptIn = !contact.dnd && (dndSettings?.whatsApp?.status !== 'active' && inboundDndSettings?.whatsApp?.status !== 'active');
            const smsOptIn = !contact.dnd && (dndSettings?.sms?.status !== 'active' && inboundDndSettings?.sms?.status !== 'active');
            const emailOptIn = !contact.dnd && (dndSettings?.email?.status !== 'active' && inboundDndSettings?.email?.status !== 'active');

            if (dryRun) {
              return { action: 'skipped' };
            }

            // Prepare extra data with all relevant fields
            const extraData = {
              ...contact,
              // Add computed fields for easier access
              source: source,
              type: type,
              dateAdded: dateAdded,
              dateUpdated: dateUpdated,
              attributionSource: attributionSource,
              lastAttributionSource: lastAttributionSource,
              // Include custom fields if present
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

    // Determine if there are more pages
    // If we got exactly CONTACTS_PER_PAGE contacts, likely there are more
    const hasMore = contacts.length >= CONTACTS_PER_PAGE;
    
    // Get pagination cursor from the last contact
    // GHL API v2.0 uses searchAfter array [timestamp, id] for pagination
    const lastContact = contacts[contacts.length - 1];
    const searchAfter = lastContact.searchAfter as [number, string] | undefined;
    
    // Extract next cursor values
    let nextStartAfterId: string | null = null;
    let nextStartAfter: number | null = null;
    
    if (searchAfter && Array.isArray(searchAfter) && searchAfter.length >= 2) {
      // searchAfter format: [timestamp, id]
      nextStartAfter = searchAfter[0] as number;
      nextStartAfterId = searchAfter[1] as string;
    } else {
      // Fallback: use contact id and dateAdded
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
    let startAfterId: string | null = null;
    let startAfter: number | null = null;
    let syncRunId: string | null = null;
    let cleanupStale = false;

    try {
      const body = await req.json();
      dryRun = body.dry_run ?? false;
      cleanupStale = body.cleanupStale === true;
      startAfterId = body.startAfterId || null;
      startAfter = body.startAfter || null;
      syncRunId = body.syncRunId || null;
    } catch {
      // Empty body is OK
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
        .insert({ source: 'ghl', status: 'running', dry_run: dryRun, checkpoint: { startAfterId: null } })
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
    logger.info(`Processing GHL page`, { startAfterId, syncRunId });

    const pageResult = await processSinglePage(
      supabase as any,
      ghlApiKey,
      ghlLocationId,
      syncRunId!,
      dryRun,
      startAfterId,
      startAfter
    );
    
    // ============ CHECK IF CANCELLED AFTER PROCESSING ============
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

    // ============ CHECK IF MORE PAGES ============
    if (pageResult.hasMore) {
      // Return continuing status with next cursor
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
      })
      .eq('id', syncRunId);

    return new Response(
      JSON.stringify({ ok: true, status: 'completed', syncRunId, processed: pageResult.contactsFetched, hasMore: false }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Fatal error", error instanceof Error ? error : new Error(String(error)));
    
    // Note: syncRunId and supabase are scoped inside try block
    // Fatal errors at this level mean we couldn't initialize properly
    
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
