import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';
import { RATE_LIMITERS } from '../_shared/rate-limiter.ts';

// Declare EdgeRuntime global for Supabase Edge Functions
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('sync-ghl', LogLevel.INFO);
const rateLimiter = RATE_LIMITERS.GHL;

// ============ CONFIGURATION ============
const FUNCTION_VERSION = '2026-02-10-1';
const CONTACTS_PER_PAGE = 100;
const STALE_TIMEOUT_MINUTES = 5; // Reduced from 30 to 5 for faster recovery
const CHAIN_RETRY_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GhlCursor = { startAfterId: string | null; startAfter: number | null; stageOnly?: boolean };

function parseGhlCursor(value: unknown): GhlCursor | null {
  if (!value) return null;

  // Array form: [timestamp, id]
  if (Array.isArray(value) && value.length >= 2) {
    const ts = value[0];
    const id = value[1];
    return {
      startAfter: typeof ts === 'number' ? ts : Number.isFinite(Number(ts)) ? Number(ts) : null,
      startAfterId: typeof id === 'string' ? id : id != null ? String(id) : null
    };
  }

  // String form: JSON or "timestamp|id"
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parseGhlCursor(parsed);
    } catch {
      // Not JSON
    }
    if (trimmed.includes('|')) {
      const [ts, id] = trimmed.split('|');
      const num = Number(ts);
      return {
        startAfter: Number.isFinite(num) ? num : null,
        startAfterId: id ? id : null
      };
    }
    return null;
  }

  // Object form: { startAfter, startAfterId, stageOnly? }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const ts = v.startAfter;
    const id = v.startAfterId;
    const stageOnly = v.stageOnly;
    const startAfter = typeof ts === 'number' ? ts : Number.isFinite(Number(ts)) ? Number(ts) : null;
    const startAfterId = typeof id === 'string' ? id : id != null ? String(id) : null;
    if (!startAfterId && startAfter === null) return null;
    return {
      startAfter,
      startAfterId,
      stageOnly: typeof stageOnly === 'boolean' ? stageOnly : undefined
    };
  }

  return null;
}

// ============ VERIFY ADMIN ============
async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  // Allow service_role for background chunking (EdgeRuntime.waitUntil triggers).
  const token = authHeader.replace('Bearer ', '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (serviceRoleKey && token === serviceRoleKey) {
    return { valid: true, userId: 'service_role' };
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
    if (startAfter !== null && startAfterId) {
      bodyParams.searchAfter = [startAfter, startAfterId];
      logger.info('Using searchAfter array for pagination', { startAfter, startAfterId });
    }

    const finalBody = JSON.stringify(bodyParams);
    
    logger.info('Fetching GHL contacts (STAGE ONLY MODE)', { 
      hasSearchAfter: startAfter !== null && !!startAfterId,
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
    if (startAfter !== null && startAfterId) {
      bodyParams.searchAfter = [startAfter, startAfterId];
      logger.info('Using searchAfter array for pagination', { startAfter, startAfterId });
    }

    const finalBody = JSON.stringify(bodyParams);
    
    logger.info('Fetching GHL contacts (V2 Search)', { 
      hasSearchAfter: startAfter !== null && !!startAfterId,
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
  logger.info('sync-ghl invoked', { version: FUNCTION_VERSION });
  
  // Declare these outside try so they're available in catch
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  let syncRunId: string | null = null;

  try {
    // SECURITY: Verify JWT + is_admin()
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: authCheck.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    // Parse request
    let dryRun = false;
    let stageOnly = false; // NEW: Stage-only mode
    let stageOnlyProvided = false;
    let testOnly = false; // TEST MODE: Just verify API connection
    let startAfterId: string | null = null;
    let startAfter: number | null = null;
    let cleanupStale = false;
    let forceCancel = false;
    // Accumulated progress across background invocations.
    // If not provided (older invocations), we fall back to sync_runs totals.
    let accumulatedFetched: number | null = null;
    let accumulatedInserted: number | null = null; // stageOnly uses this as "staged"
    let accumulatedUpdated: number | null = null;
    let accumulatedSkipped: number | null = null;
    let accumulatedConflicts: number | null = null;
    let resumeFromCursor: unknown = null;

    try {
      const body = await req.json();
      dryRun = body.dry_run ?? body.dryRun ?? false;
      if (typeof body.stageOnly === 'boolean') {
        stageOnly = body.stageOnly;
        stageOnlyProvided = true;
      } else if (typeof body.stage_only === 'boolean') {
        stageOnly = body.stage_only;
        stageOnlyProvided = true;
      } else {
        stageOnly = false;
      }
      testOnly = body.testOnly ?? false; // TEST MODE
      cleanupStale = body.cleanupStale === true;
      forceCancel = body.forceCancel === true;
      startAfterId = body.startAfterId ?? null;
      startAfter = body.startAfter ?? null;
      syncRunId = body.syncRunId ?? null;
      // Common aliases used by other sync functions
      const bodyAccumFetched = body.accumulatedFetched ?? body.accumulatedTotal;
      const bodyAccumInserted = body.accumulatedInserted ?? body.accumulatedStored;
      accumulatedFetched = typeof bodyAccumFetched === 'number' ? bodyAccumFetched : null;
      accumulatedInserted = typeof bodyAccumInserted === 'number' ? bodyAccumInserted : null;
      accumulatedUpdated = typeof body.accumulatedUpdated === 'number' ? body.accumulatedUpdated : null;
      accumulatedSkipped = typeof body.accumulatedSkipped === 'number' ? body.accumulatedSkipped : null;
      accumulatedConflicts = typeof body.accumulatedConflicts === 'number' ? body.accumulatedConflicts : null;
      resumeFromCursor = body.resumeFromCursor ?? body.resume_cursor ?? null;
    } catch {
      // Empty body is OK
    }

    // If resume cursor is provided, prefer it when explicit startAfter/startAfterId are missing.
    if ((startAfterId === null || startAfter === null) && resumeFromCursor) {
      const parsed = parseGhlCursor(resumeFromCursor);
      if (parsed) {
        if (startAfterId === null && parsed.startAfterId) startAfterId = parsed.startAfterId;
        if (startAfter === null && parsed.startAfter !== null) startAfter = parsed.startAfter;
        if (!stageOnlyProvided && typeof parsed.stageOnly === 'boolean') stageOnly = parsed.stageOnly;
      }
    }

    // ============ TEST ONLY MODE - Just verify API connection ============
    if (testOnly) {
      if (!ghlApiKey || !ghlLocationId) {
        return new Response(
          JSON.stringify({
            ok: false,
            success: false,
            status: 'error',
            error: 'GHL_API_KEY and GHL_LOCATION_ID secrets required',
            testOnly: true,
            version: FUNCTION_VERSION
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

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
            testOnly: true,
            version: FUNCTION_VERSION
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
            testOnly: true,
            version: FUNCTION_VERSION
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ============= KILL SWITCH: Check if GHL is paused =============
    const { data: ghlPausedConfig } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'ghl_paused')
      .single();

    if (ghlPausedConfig?.value === 'true') {
      logger.info('🛑 GHL PAUSED - Manual sync blocked');
      return new Response(
        JSON.stringify({ 
          ok: false, 
          success: false,
          status: 'paused',
          error: 'GoHighLevel está pausado. Actívalo desde Settings → Configuración del Sistema.',
          version: FUNCTION_VERSION
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    // ================================================================

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ ok: false, error: 'GHL_API_KEY and GHL_LOCATION_ID secrets required', version: FUNCTION_VERSION }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
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
          message: `Se cancelaron ${cancelledSyncs?.length || 0} sincronizaciones de GHL`,
          version: FUNCTION_VERSION
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
      return new Response(JSON.stringify({ ok: true, cleaned: staleSyncs?.length || 0, version: FUNCTION_VERSION }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ============ CHECK FOR EXISTING SYNC ============
    if (!syncRunId) {
      const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
      // Clean stale first
      await supabase.from('sync_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout' })
        .eq('source', 'ghl').in('status', ['running', 'continuing']).lt('started_at', staleThreshold);

      const { data: existingRuns } = await supabase.from('sync_runs').select('id').eq('source', 'ghl').in('status', ['running', 'continuing']).limit(1);
      if (existingRuns && existingRuns.length > 0) {
        return new Response(JSON.stringify({ ok: false, status: 'already_running', error: 'Sync in progress', syncRunId: existingRuns[0].id, version: FUNCTION_VERSION }), { status: 409, headers: corsHeaders });
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
          metadata: { stageOnly, functionVersion: FUNCTION_VERSION } // Track mode + version
        })
        .select('id').single();
      syncRunId = syncRun?.id;
    } else {
      await supabase
        .from('sync_runs')
        .update({
          status: 'running',
          checkpoint: { startAfterId, startAfter, lastActivity: new Date().toISOString() }
        })
        .eq('id', syncRunId);
    }

    // ============ CHECK IF CANCELLED BEFORE PROCESSING ============
    const { data: syncCheck } = await supabase
      .from('sync_runs')
      .select('status, total_fetched, total_inserted, total_updated, total_skipped, total_conflicts')
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
      // Determine starting totals (prefer request accumulators; fall back to DB totals for compatibility)
      const baseFetched = accumulatedFetched ?? syncCheck?.total_fetched ?? 0;
      const baseInserted = accumulatedInserted ?? syncCheck?.total_inserted ?? 0;

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

      const newAccumulatedFetched = baseFetched + pageResult.contactsFetched;
      const newAccumulatedInserted = baseInserted + pageResult.staged;

      if (pageResult.hasMore) {
        // Guardrail: prevent an infinite background loop if pagination cursor is missing or not advancing.
        if (!pageResult.nextStartAfterId || pageResult.nextStartAfter === null) {
          const msg = 'GHL pagination cursor missing; aborting to avoid infinite loop.';
          logger.error(msg, new Error(msg), { syncRunId, startAfterId, startAfter });
          await supabase
            .from('sync_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
            .eq('id', syncRunId);
          return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
        }
        if (pageResult.nextStartAfterId === startAfterId && pageResult.nextStartAfter === startAfter) {
          const msg = 'GHL pagination cursor did not advance; aborting to avoid infinite loop.';
          logger.error(msg, new Error(msg), { syncRunId, startAfterId, startAfter });
          await supabase
            .from('sync_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
            .eq('id', syncRunId);
          return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
        }

        await supabase
          .from('sync_runs')
          .update({
            status: 'continuing',
            total_fetched: newAccumulatedFetched,
            total_inserted: newAccumulatedInserted,
            checkpoint: {
              startAfterId: pageResult.nextStartAfterId,
              startAfter: pageResult.nextStartAfter,
              cursor: [pageResult.nextStartAfter, pageResult.nextStartAfterId],
              lastActivity: new Date().toISOString(),
              canResume: true,
              runningTotal: newAccumulatedFetched,
              stageOnly: true,
              functionVersion: FUNCTION_VERSION
            }
          })
          .eq('id', syncRunId);

        // CRITICAL: Use EdgeRuntime.waitUntil for background processing
        // This allows the HTTP response to return immediately while processing continues
        const nextChunkUrl = `${supabaseUrl}/functions/v1/sync-ghl`;
        const invokeNextChunk = async () => {
          const payload = JSON.stringify({
            syncRunId,
            stageOnly: true,
            startAfterId: pageResult.nextStartAfterId,
            startAfter: pageResult.nextStartAfter,
            accumulatedFetched: newAccumulatedFetched,
            accumulatedInserted: newAccumulatedInserted
          });

          await delay(500); // Small delay to reduce chain burst / gateway throttling

          for (let attempt = 1; attempt <= CHAIN_RETRY_ATTEMPTS; attempt++) {
            try {
              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
                // Some gateways require explicit apikey even when Authorization is present.
                // Use anon key here to match documented invocation format.
                'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? supabaseKey
              };

              const response = await fetch(nextChunkUrl, {
                method: 'POST',
                headers,
                body: payload
              });

              if (response.ok) {
                logger.info(`Chain invocation succeeded (attempt ${attempt})`, { syncRunId });
                return;
              }

              const respText = await response.text();
              logger.warn(`Chain invocation returned ${response.status} (attempt ${attempt}/${CHAIN_RETRY_ATTEMPTS})`, {
                syncRunId,
                status: response.status,
                bodyPreview: respText.substring(0, 200)
              });
            } catch (err) {
              logger.error(`Chain attempt ${attempt} failed`, err instanceof Error ? err : new Error(String(err)), { syncRunId });
            }

            if (attempt < CHAIN_RETRY_ATTEMPTS) {
              await delay(2000 * attempt); // Exponential backoff
            }
          }

          // All retries failed - mark sync paused for manual resume.
          const msg = 'Auto-chain failed after retries; sync paused for manual resume.';
          logger.error(msg, new Error(msg), { syncRunId });
          try {
            await supabase
              .from('sync_runs')
              .update({
                status: 'paused',
                error_message: 'Auto-chain falló. Haz clic en Reanudar para continuar.',
                checkpoint: {
                  startAfterId: pageResult.nextStartAfterId,
                  startAfter: pageResult.nextStartAfter,
                  cursor: [pageResult.nextStartAfter, pageResult.nextStartAfterId],
                  lastActivity: new Date().toISOString(),
                  canResume: true,
                  runningTotal: newAccumulatedFetched,
                  stageOnly: true,
                  chainFailed: true,
                  functionVersion: FUNCTION_VERSION
                }
              })
              .eq('id', syncRunId);
          } catch (updateErr) {
            logger.error('Failed to mark sync as paused after chain failure', updateErr instanceof Error ? updateErr : new Error(String(updateErr)), { syncRunId });
          }
        };

        // Use EdgeRuntime.waitUntil if available, otherwise fire-and-forget
        if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
          EdgeRuntime.waitUntil(invokeNextChunk());
        } else {
          // Fallback: fire and forget (less reliable but works)
          invokeNextChunk();
        }

        return new Response(
          JSON.stringify({
            ok: true,
            status: 'continuing',
            syncRunId,
            processed: newAccumulatedFetched,
            staged: newAccumulatedInserted,
            hasMore: true,
            nextStartAfterId: pageResult.nextStartAfterId,
            nextStartAfter: pageResult.nextStartAfter,
            stageOnly: true,
            backgroundProcessing: true,
            message: 'Sync continues in background. Check sync_runs for progress.',
            version: FUNCTION_VERSION
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
          total_fetched: newAccumulatedFetched,
          total_inserted: newAccumulatedInserted,
        })
        .eq('id', syncRunId);

      return new Response(
        JSON.stringify({ 
          ok: true, 
          status: 'completed', 
          syncRunId, 
          processed: newAccumulatedFetched, 
          staged: newAccumulatedInserted,
          hasMore: false,
          stageOnly: true,
          message: 'Staging complete. Run unify-all-sources to merge into clients.',
          version: FUNCTION_VERSION
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // LEGACY: Full merge mode
    // Determine starting totals (prefer request accumulators; fall back to DB totals for compatibility)
    const baseFetched = accumulatedFetched ?? syncCheck?.total_fetched ?? 0;
    const baseInserted = accumulatedInserted ?? syncCheck?.total_inserted ?? 0;
    const baseUpdated = accumulatedUpdated ?? syncCheck?.total_updated ?? 0;
    const baseSkipped = accumulatedSkipped ?? syncCheck?.total_skipped ?? 0;
    const baseConflicts = accumulatedConflicts ?? syncCheck?.total_conflicts ?? 0;

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

    const newAccumulatedFetched = baseFetched + pageResult.contactsFetched;
    const newAccumulatedInserted = baseInserted + pageResult.inserted;
    const newAccumulatedUpdated = baseUpdated + pageResult.updated;
    const newAccumulatedSkipped = baseSkipped + pageResult.skipped;
    const newAccumulatedConflicts = baseConflicts + pageResult.conflicts;

    if (pageResult.hasMore) {
      // Guardrail: prevent an infinite background loop if pagination cursor is missing or not advancing.
      if (!pageResult.nextStartAfterId || pageResult.nextStartAfter === null) {
        const msg = 'GHL pagination cursor missing; aborting to avoid infinite loop.';
        logger.error(msg, new Error(msg), { syncRunId, startAfterId, startAfter });
        await supabase
          .from('sync_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
          .eq('id', syncRunId);
        return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
      }
      if (pageResult.nextStartAfterId === startAfterId && pageResult.nextStartAfter === startAfter) {
        const msg = 'GHL pagination cursor did not advance; aborting to avoid infinite loop.';
        logger.error(msg, new Error(msg), { syncRunId, startAfterId, startAfter });
        await supabase
          .from('sync_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
          .eq('id', syncRunId);
        return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
      }

      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: newAccumulatedFetched,
          total_inserted: newAccumulatedInserted,
          total_updated: newAccumulatedUpdated,
          total_skipped: newAccumulatedSkipped,
          total_conflicts: newAccumulatedConflicts,
          checkpoint: {
            startAfterId: pageResult.nextStartAfterId,
            startAfter: pageResult.nextStartAfter,
            cursor: [pageResult.nextStartAfter, pageResult.nextStartAfterId],
            lastActivity: new Date().toISOString(),
            canResume: true,
            runningTotal: newAccumulatedFetched,
            stageOnly: false,
            functionVersion: FUNCTION_VERSION
          }
        })
        .eq('id', syncRunId);

      // CRITICAL: Use EdgeRuntime.waitUntil for background processing
      const nextChunkUrl = `${supabaseUrl}/functions/v1/sync-ghl`;
      const invokeNextChunk = async () => {
        const payload = JSON.stringify({
          syncRunId,
          stageOnly: false,
          startAfterId: pageResult.nextStartAfterId,
          startAfter: pageResult.nextStartAfter,
          dry_run: dryRun,
          accumulatedFetched: newAccumulatedFetched,
          accumulatedInserted: newAccumulatedInserted,
          accumulatedUpdated: newAccumulatedUpdated,
          accumulatedSkipped: newAccumulatedSkipped,
          accumulatedConflicts: newAccumulatedConflicts
        });

        await delay(500); // Small delay to reduce chain burst / gateway throttling

        for (let attempt = 1; attempt <= CHAIN_RETRY_ATTEMPTS; attempt++) {
          try {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
              'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? supabaseKey
            };

            const response = await fetch(nextChunkUrl, {
              method: 'POST',
              headers,
              body: payload
            });

            if (response.ok) {
              logger.info(`Chain invocation succeeded (attempt ${attempt})`, { syncRunId });
              return;
            }

            const respText = await response.text();
            logger.warn(`Chain invocation returned ${response.status} (attempt ${attempt}/${CHAIN_RETRY_ATTEMPTS})`, {
              syncRunId,
              status: response.status,
              bodyPreview: respText.substring(0, 200)
            });
          } catch (err) {
            logger.error(`Chain attempt ${attempt} failed`, err instanceof Error ? err : new Error(String(err)), { syncRunId });
          }

          if (attempt < CHAIN_RETRY_ATTEMPTS) {
            await delay(2000 * attempt); // Exponential backoff
          }
        }

        const msg = 'Auto-chain failed after retries; sync paused for manual resume.';
        logger.error(msg, new Error(msg), { syncRunId });
        try {
          await supabase
            .from('sync_runs')
            .update({
              status: 'paused',
              error_message: 'Auto-chain falló. Haz clic en Reanudar para continuar.',
              checkpoint: {
                startAfterId: pageResult.nextStartAfterId,
                startAfter: pageResult.nextStartAfter,
                cursor: [pageResult.nextStartAfter, pageResult.nextStartAfterId],
                lastActivity: new Date().toISOString(),
                canResume: true,
                runningTotal: newAccumulatedFetched,
                stageOnly: false,
                chainFailed: true,
                functionVersion: FUNCTION_VERSION
              }
            })
            .eq('id', syncRunId);
        } catch (updateErr) {
          logger.error('Failed to mark sync as paused after chain failure', updateErr instanceof Error ? updateErr : new Error(String(updateErr)), { syncRunId });
        }
      };

      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(invokeNextChunk());
      } else {
        invokeNextChunk();
      }

      return new Response(
        JSON.stringify({
          ok: true,
          status: 'continuing',
          syncRunId,
          processed: newAccumulatedFetched,
          hasMore: true,
          nextStartAfterId: pageResult.nextStartAfterId,
          nextStartAfter: pageResult.nextStartAfter,
          backgroundProcessing: true,
          message: 'Sync continues in background.',
          version: FUNCTION_VERSION
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
        total_fetched: newAccumulatedFetched,
        total_inserted: newAccumulatedInserted,
        total_updated: newAccumulatedUpdated,
        total_skipped: newAccumulatedSkipped,
        total_conflicts: newAccumulatedConflicts,
      })
      .eq('id', syncRunId);

    return new Response(
      JSON.stringify({ ok: true, status: 'completed', syncRunId, processed: newAccumulatedFetched, hasMore: false, version: FUNCTION_VERSION }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorObj = error instanceof Error ? error : new Error(errorMessage);
    logger.error("Fatal sync-ghl error", errorObj);
    
    // CRITICAL: Mark sync_runs as failed so frontend stops polling
    if (syncRunId) {
      try {
        await supabase
          .from('sync_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorMessage
          })
          .eq('id', syncRunId);
        logger.info('Marked sync run as failed', { id: syncRunId });
      } catch (updateErr) {
        const updateErrObj = updateErr instanceof Error ? updateErr : new Error(String(updateErr));
        logger.error('Failed to update sync_runs status', updateErrObj);
      }
    }
    
    return new Response(
      JSON.stringify({ ok: false, success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
