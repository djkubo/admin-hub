import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';
import { RATE_LIMITERS } from '../_shared/rate-limiter.ts';
import { readSyncState, writeSyncStateError, writeSyncStateSuccess } from '../_shared/sync_state.ts';

// Declare EdgeRuntime global for Supabase Edge Functions
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('sync-ghl', LogLevel.INFO);
const rateLimiter = RATE_LIMITERS.GHL;

// ============ CONFIGURATION ============
const FUNCTION_VERSION = '2026-02-10-3';
const CONTACTS_PER_PAGE = 100;
const STALE_TIMEOUT_MINUTES = 5; // Reduced from 30 to 5 for faster recovery
const CHAIN_RETRY_ATTEMPTS = 3;
const CHAIN_FETCH_TIMEOUT_MS = 10_000;
const GHL_API_FETCH_TIMEOUT_MS = 25_000;
const GHL_429_MAX_ATTEMPTS = 6;
const GHL_429_BASE_DELAY_MS = 2_000;
const GHL_429_MAX_DELAY_MS = 60_000;
const INVOCATION_TIME_BUDGET_MS = 50_000; // keep under common 60s function limits
const DEFAULT_MAX_PAGES_STAGE_ONLY = 10;
const DEFAULT_MAX_PAGES_MERGE = 3;
const MAX_MAX_PAGES = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const value = retryAfter.trim();
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000));
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function isRateLimitErrorMessage(message: string | null | undefined): boolean {
  const msg = (message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit');
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchGhlContactsSearch(
  ghlUrl: string,
  ghlApiKey: string,
  finalBody: string
): Promise<Response> {
  return await retryWithBackoff(
    () => rateLimiter.execute(async () => {
      try {
        const response = await fetchWithTimeout(
          ghlUrl,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${ghlApiKey}`,
              'Version': '2021-07-28',
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            body: finalBody
          },
          GHL_API_FETCH_TIMEOUT_MS
        );

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const waitMs = Math.min(
            Math.max(retryAfterMs ?? GHL_429_BASE_DELAY_MS, GHL_429_BASE_DELAY_MS),
            GHL_429_MAX_DELAY_MS
          );
          logger.warn('GHL returned 429, backing off before retry', { waitMs });
          await delay(waitMs);
          throw new Error(`429 Too Many Requests (waited ${waitMs}ms)`);
        }

        return response;
      } catch (err) {
        // Ensure timeouts are treated as retryable (retry.ts checks ETIMEDOUT string/code).
        const name =
          (err && typeof err === 'object' && 'name' in err) ? String((err as { name?: unknown }).name) : '';
        if (name === 'AbortError') {
          const e = new Error('ETIMEDOUT: GHL request timed out');
          (e as { code?: string }).code = 'ETIMEDOUT';
          throw e;
        }
        throw err;
      }
    }),
    {
      ...RETRY_CONFIGS.AGGRESSIVE,
      maxAttempts: GHL_429_MAX_ATTEMPTS,
      initialDelayMs: GHL_429_BASE_DELAY_MS,
      maxDelayMs: GHL_429_MAX_DELAY_MS,
      retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.GHL, ...RETRYABLE_ERRORS.HTTP]
    }
  );
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

    const ghlResponse = await fetchGhlContactsSearch(ghlUrl, ghlApiKey, finalBody);

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

    // STAGE ONLY: Save raw contacts in batches without merging.
    // IMPORTANT: Do NOT include processed_at in upsert records.
    // On INSERT (new contact): DB default is NULL → will be picked up by unifier.
    // On UPDATE (existing contact): processed_at is NOT overwritten, so already-processed
    // contacts keep their timestamp and won't re-enter the pending queue.
    // Only reset processed_at if the payload actually changed (dateUpdated differs).
    const BATCH_SIZE = 50;
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);

      // Split into truly new vs potentially existing
      const externalIds = batch.map((c: Record<string, unknown>) => c.id as string);
      const { data: existingRows } = await supabase
        .from('ghl_contacts_raw')
        .select('external_id, payload')
        .in('external_id', externalIds);

      const existingMap = new Map<string, any>();
      for (const row of (existingRows || [])) {
        existingMap.set(row.external_id, row.payload);
      }

      const toUpsert: Array<Record<string, unknown>> = [];
      for (const contact of batch) {
        const extId = contact.id as string;
        const oldPayload = existingMap.get(extId);
        const record: Record<string, unknown> = {
          external_id: extId,
          payload: contact,
          sync_run_id: syncRunId,
          fetched_at: new Date().toISOString(),
        };

        if (oldPayload) {
          // Existing record: only reset processed_at if payload changed
          const oldUpdated = oldPayload?.dateUpdated || oldPayload?.updatedAt;
          const newUpdated = (contact as any).dateUpdated || (contact as any).updatedAt;
          if (newUpdated && oldUpdated && newUpdated !== oldUpdated) {
            record.processed_at = null; // payload changed → re-process
          }
          // else: don't touch processed_at (keeps existing value via upsert)
        }
        // New record: processed_at omitted → DB default NULL → picked up by unifier

        toUpsert.push(record);
      }

      if (toUpsert.length === 0) continue;

      const { error: upsertError } = await supabase
        .from('ghl_contacts_raw')
        .upsert(toUpsert, { onConflict: 'external_id', ignoreDuplicates: false });

      if (upsertError) {
        if (upsertError.message?.includes('ON CONFLICT') || upsertError.message?.includes('unique')) {
          logger.warn('Upsert failed, using delete+insert fallback', { error: upsertError.message });
          await supabase.from('ghl_contacts_raw').delete().in('external_id', externalIds);
          const { error: insertError } = await supabase.from('ghl_contacts_raw').insert(toUpsert);
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

    const ghlResponse = await fetchGhlContactsSearch(ghlUrl, ghlApiKey, finalBody);

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
    let maxPages: number | null = null;
    let noChain = false;
    let force = false;
    let existingCheckpoint: Record<string, unknown> | null = null;

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
      const bodyStartAfterId = body.startAfterId ?? body.start_after_id ?? null;
      startAfterId =
        typeof bodyStartAfterId === 'string'
          ? bodyStartAfterId
          : bodyStartAfterId != null
            ? String(bodyStartAfterId)
            : null;
      startAfter = toNumberOrNull(body.startAfter ?? body.start_after);
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

      const bodyMaxPages = body.maxPages ?? body.max_pages ?? null;
      maxPages = typeof bodyMaxPages === 'number' ? bodyMaxPages : Number.isFinite(Number(bodyMaxPages)) ? Number(bodyMaxPages) : null;
      const chainMode = body.chainMode ?? body.chain_mode ?? null;
      noChain = body.noChain === true || body.no_chain === true || chainMode === 'none' || chainMode === 'client';
      force = body.force === true;
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

    // For explicit resume by syncRunId, recover cursor/startAfter from DB checkpoint when body omits it.
    if (syncRunId) {
      const { data: existingRun } = await supabase
        .from('sync_runs')
        .select('checkpoint, metadata')
        .eq('id', syncRunId)
        .maybeSingle();

      existingCheckpoint =
        existingRun && typeof existingRun.checkpoint === 'object' && existingRun.checkpoint !== null
          ? (existingRun.checkpoint as Record<string, unknown>)
          : null;

      if (!stageOnlyProvided && existingCheckpoint && typeof existingCheckpoint.stageOnly === 'boolean') {
        stageOnly = existingCheckpoint.stageOnly;
      }

      if (startAfterId === null || startAfter === null) {
        const cpStartAfterIdRaw = existingCheckpoint?.startAfterId;
        const cpStartAfterId =
          typeof cpStartAfterIdRaw === 'string'
            ? cpStartAfterIdRaw
            : cpStartAfterIdRaw != null
              ? String(cpStartAfterIdRaw)
              : null;
        const cpStartAfter = toNumberOrNull(existingCheckpoint?.startAfter);

        if (startAfterId === null && cpStartAfterId) startAfterId = cpStartAfterId;
        if (startAfter === null && cpStartAfter !== null) startAfter = cpStartAfter;

        if ((startAfterId === null || startAfter === null) && existingCheckpoint?.cursor) {
          const parsedCpCursor = parseGhlCursor(existingCheckpoint.cursor);
          if (parsedCpCursor) {
            if (startAfterId === null && parsedCpCursor.startAfterId) startAfterId = parsedCpCursor.startAfterId;
            if (startAfter === null && parsedCpCursor.startAfter !== null) startAfter = parsedCpCursor.startAfter;
            if (!stageOnlyProvided && typeof parsedCpCursor.stageOnly === 'boolean') stageOnly = parsedCpCursor.stageOnly;
          }
        }
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
      const thresholdMs = Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000;
      const nowIso = new Date().toISOString();

      const { data: running } = await supabase
        .from('sync_runs')
        .select('id, started_at, checkpoint')
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing']);

      const staleIds = (running || [])
        .filter((r: { started_at: string; checkpoint: unknown }) => {
          const cp = (typeof r.checkpoint === 'object' && r.checkpoint !== null)
            ? (r.checkpoint as Record<string, unknown>)
            : null;
          const lastActivity = cp && typeof cp.lastActivity === 'string' ? (cp.lastActivity as string) : null;
          const lastActivityMs = lastActivity ? new Date(lastActivity).getTime() : NaN;
          const lastMs = Number.isFinite(lastActivityMs) ? lastActivityMs : new Date(r.started_at).getTime();
          return lastMs < thresholdMs;
        })
        .map((r: { id: string }) => r.id);

      const { data: staleSyncs } = staleIds.length > 0
        ? await supabase
            .from('sync_runs')
            .update({ status: 'failed', completed_at: nowIso, error_message: 'Timeout - stale' })
            .in('id', staleIds)
            .select('id')
        : { data: [] as Array<{ id: string }> };

      return new Response(
        JSON.stringify({ ok: true, cleaned: staleSyncs?.length || 0, version: FUNCTION_VERSION }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ CHECK FOR EXISTING SYNC ============
    if (!syncRunId) {
      const thresholdMs = Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000;
      const nowIso = new Date().toISOString();

      const { data: active } = await supabase
        .from('sync_runs')
        .select('id, started_at, checkpoint')
        .eq('source', 'ghl')
        .in('status', ['running', 'continuing'])
        .order('started_at', { ascending: false });

      if (active && active.length > 0) {
        let existingActiveId: string | null = null;
        const staleIds: string[] = [];

        for (const r of active as Array<{ id: string; started_at: string; checkpoint: unknown }>) {
          const cp = (typeof r.checkpoint === 'object' && r.checkpoint !== null)
            ? (r.checkpoint as Record<string, unknown>)
            : null;
          const lastActivity = cp && typeof cp.lastActivity === 'string' ? (cp.lastActivity as string) : null;
          const lastActivityMs = lastActivity ? new Date(lastActivity).getTime() : NaN;
          const lastMs = Number.isFinite(lastActivityMs) ? lastActivityMs : new Date(r.started_at).getTime();
          const isStale = lastMs < thresholdMs;
          if (isStale) staleIds.push(r.id);
          else if (!existingActiveId) existingActiveId = r.id;
        }

        if (staleIds.length > 0) {
          await supabase
            .from('sync_runs')
            .update({ status: 'failed', completed_at: nowIso, error_message: 'Timeout' })
            .in('id', staleIds);
        }

        if (existingActiveId) {
          return new Response(
            JSON.stringify({ ok: false, status: 'already_running', error: 'Sync in progress', syncRunId: existingActiveId, version: FUNCTION_VERSION }),
            { status: 409, headers: corsHeaders }
          );
        }
      }
    }

    // ============ AUTO-SKIP (avoid redundant re-sync clicks) ============
    if (!force && !syncRunId) {
      const syncState = await readSyncState(supabase, 'ghl');
      const freshUntilMs = syncState?.fresh_until ? Date.parse(syncState.fresh_until) : null;
      const RECENT_SKIP_MS = 2 * 60 * 60 * 1000; // 2h
      if (freshUntilMs !== null && Number.isFinite(freshUntilMs) && (Date.now() - freshUntilMs) < RECENT_SKIP_MS) {
        return new Response(
          JSON.stringify({
            ok: true,
            success: true,
            status: 'skipped',
            skipped: true,
            reason: 'already_fresh',
            message: 'GoHighLevel: ya se sincronizó recientemente (usa Forzar si necesitas re-sincronizar).',
            syncState,
            version: FUNCTION_VERSION
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
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
      const checkpointPayload: Record<string, unknown> = {
        ...(existingCheckpoint ?? {}),
        lastActivity: new Date().toISOString(),
        stageOnly,
        functionVersion: FUNCTION_VERSION,
      };
      if (startAfterId && startAfter !== null) {
        checkpointPayload.startAfterId = startAfterId;
        checkpointPayload.startAfter = startAfter;
        checkpointPayload.cursor = [startAfter, startAfterId];
      }

      await supabase
        .from('sync_runs')
        .update({
          status: 'running',
          checkpoint: checkpointPayload
        })
        // IMPORTANT: Do not resurrect cancelled/completed runs. This also makes
        // "cancel individual sync" reliable even if a background chain request
        // is already in-flight.
        .eq('id', syncRunId)
        .in('status', ['running', 'continuing', 'paused', 'failed']);
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
      const maxPagesToProcess = Math.min(
        Math.max(
          1,
          Math.floor(
            (typeof maxPages === 'number' && Number.isFinite(maxPages) ? maxPages : DEFAULT_MAX_PAGES_STAGE_ONLY)
          )
        ),
        MAX_MAX_PAGES
      );
      const invocationDeadline = startTime + INVOCATION_TIME_BUDGET_MS;

      // Determine starting totals (prefer request accumulators; fall back to DB totals for compatibility)
      let runningFetched = accumulatedFetched ?? syncCheck?.total_fetched ?? 0;
      let runningInserted = accumulatedInserted ?? syncCheck?.total_inserted ?? 0;

      let currentStartAfterId: string | null = startAfterId;
      let currentStartAfter: number | null = startAfter;
      let pagesProcessed = 0;
      let hasMore = true;

      while (hasMore && pagesProcessed < maxPagesToProcess) {
        if (pagesProcessed > 0 && Date.now() > invocationDeadline) {
          logger.warn('Invocation time budget reached; stopping early', { syncRunId, pagesProcessed });
          break;
        }

        // Check if sync was cancelled before fetching next page
        const { data: cancelCheck } = await supabase
          .from('sync_runs')
          .select('status')
          .eq('id', syncRunId!)
          .single() as { data: { status: string } | null };

        if (cancelCheck?.status === 'canceled' || cancelCheck?.status === 'cancelled') {
          logger.info('Sync cancelled, stopping', { syncRunId });
          return new Response(
            JSON.stringify({ ok: false, status: 'canceled', error: 'Sync was cancelled by user' }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const pageLoopStart = Date.now();
        const pageResult = await processSinglePageStageOnly(
          supabase as ReturnType<typeof createClient>,
          ghlApiKey,
          ghlLocationId,
          syncRunId!,
          currentStartAfterId,
          currentStartAfter
        );

        const pageDuration = Date.now() - pageLoopStart;
        logger.info('GHL page staged', {
          duration_ms: pageDuration,
          contactsFetched: pageResult.contactsFetched,
          staged: pageResult.staged,
          pageIndex: pagesProcessed + 1,
          maxPages: maxPagesToProcess
        });

	      if (pageResult.error) {
          const isRateLimit = isRateLimitErrorMessage(pageResult.error);
          if (isRateLimit) {
            const msg = 'GHL rate limit (429): sync pausado para reintentar luego con Reanudar.';
            await supabase
              .from('sync_runs')
              .update({
                status: 'paused',
                error_message: msg,
                checkpoint: {
                  startAfterId: currentStartAfterId,
                  startAfter: currentStartAfter,
                  cursor: (currentStartAfter !== null && currentStartAfterId) ? [currentStartAfter, currentStartAfterId] : null,
                  lastActivity: new Date().toISOString(),
                  canResume: true,
                  runningTotal: runningFetched,
                  stageOnly: true,
                  functionVersion: FUNCTION_VERSION,
                  maxPagesPerInvocation: maxPagesToProcess
                }
              })
              .eq('id', syncRunId)
              // Don't override user cancellation
              .in('status', ['running', 'continuing']);
            await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
            return new Response(
              JSON.stringify({ ok: false, status: 'paused', syncRunId, error: msg }),
              { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }

	        await supabase
	          .from('sync_runs')
	          .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: pageResult.error })
	          .eq('id', syncRunId)
	          // Don't override user cancellation
	          .in('status', ['running', 'continuing']);
          await writeSyncStateError({ supabase, source: 'ghl', errorMessage: pageResult.error });
	        return new Response(JSON.stringify({ ok: false, error: pageResult.error }), { status: 500, headers: corsHeaders });
	      }

        runningFetched += pageResult.contactsFetched;
        runningInserted += pageResult.staged;
        hasMore = pageResult.hasMore;

        if (hasMore) {
          // Guardrail: prevent an infinite loop if pagination cursor is missing or not advancing.
	        if (!pageResult.nextStartAfterId || pageResult.nextStartAfter === null) {
	          const msg = 'GHL pagination cursor missing; aborting to avoid infinite loop.';
	          logger.error(msg, new Error(msg), { syncRunId, currentStartAfterId, currentStartAfter });
	          await supabase
	            .from('sync_runs')
	            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
	            .eq('id', syncRunId)
	            // Don't override user cancellation
	            .in('status', ['running', 'continuing']);
            await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
	          return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
	        }
	        if (pageResult.nextStartAfterId === currentStartAfterId && pageResult.nextStartAfter === currentStartAfter) {
	          const msg = 'GHL pagination cursor did not advance; aborting to avoid infinite loop.';
	          logger.error(msg, new Error(msg), { syncRunId, currentStartAfterId, currentStartAfter });
	          await supabase
	            .from('sync_runs')
	            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
	            .eq('id', syncRunId)
	            // Don't override user cancellation
	            .in('status', ['running', 'continuing']);
            await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
	          return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
	        }

          currentStartAfterId = pageResult.nextStartAfterId;
          currentStartAfter = pageResult.nextStartAfter;
        }

        // Save progress after each page so the UI never looks stuck on 100.
        const { data: progressRows } = await supabase
          .from('sync_runs')
          .update({
            status: hasMore ? 'continuing' : 'running',
            total_fetched: runningFetched,
            total_inserted: runningInserted,
            checkpoint: {
              startAfterId: currentStartAfterId,
              startAfter: currentStartAfter,
              cursor: (currentStartAfter !== null && currentStartAfterId) ? [currentStartAfter, currentStartAfterId] : null,
              lastActivity: new Date().toISOString(),
              canResume: true,
              runningTotal: runningFetched,
              stageOnly: true,
              functionVersion: FUNCTION_VERSION,
              pagesProcessedThisInvocation: pagesProcessed + 1,
              maxPagesPerInvocation: maxPagesToProcess,
              noChainRequested: noChain
            }
          })
          .eq('id', syncRunId)
          // Don't override user cancellation
          .in('status', ['running', 'continuing'])
          .select('id');

        if (!progressRows || progressRows.length === 0) {
          logger.info('Sync not active (likely cancelled); stopping', { syncRunId });
          return new Response(
            JSON.stringify({ ok: false, status: 'cancelled', error: 'Sync was cancelled by user', syncRunId, version: FUNCTION_VERSION }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        pagesProcessed++;
        if (!hasMore) break;
      }

      // If this invocation finished the dataset, mark completed.
      if (!hasMore) {
        const { data: completedRows } = await supabase
          .from('sync_runs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            total_fetched: runningFetched,
            total_inserted: runningInserted,
            checkpoint: null
          })
          .eq('id', syncRunId)
          // Don't override user cancellation
          .in('status', ['running', 'continuing'])
          .select('id');

        if (!completedRows || completedRows.length === 0) {
          logger.info('Sync not marked completed (likely cancelled); stopping', { syncRunId });
          return new Response(
            JSON.stringify({ ok: false, status: 'cancelled', error: 'Sync was cancelled by user', syncRunId, version: FUNCTION_VERSION }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        await writeSyncStateSuccess({
          supabase,
          source: 'ghl',
          runId: syncRunId,
          status: 'completed',
          meta: {
            stageOnly: true,
            functionVersion: FUNCTION_VERSION,
            totalFetched: runningFetched,
            totalInserted: runningInserted,
          },
          rangeStart: null,
          rangeEnd: new Date().toISOString(),
        });

        return new Response(
          JSON.stringify({
            ok: true,
            status: 'completed',
            syncRunId,
            processed: runningFetched,
            staged: runningInserted,
            hasMore: false,
            stageOnly: true,
            pagesProcessed,
            message: 'Staging complete. Run unify-all-sources to merge into clients.',
            version: FUNCTION_VERSION
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Still has more pages. Either auto-chain (default) or return cursor for client-driven continuation.
      const nextStartAfterId = currentStartAfterId;
      const nextStartAfter = currentStartAfter;

      if (!nextStartAfterId || nextStartAfter === null) {
        const msg = 'GHL pagination cursor missing after processing; cannot continue.';
        logger.error(msg, new Error(msg), { syncRunId, nextStartAfterId, nextStartAfter });
        await supabase
          .from('sync_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
          .eq('id', syncRunId);
        await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
        return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
      }

      if (!noChain) {
        const nextChunkUrl = `${supabaseUrl}/functions/v1/sync-ghl`;

        // Mark that we intend to chain (helps debugging "stuck at 100" cases).
        const { data: chainRows } = await supabase
          .from('sync_runs')
          .update({
            status: 'continuing',
            checkpoint: {
              startAfterId: nextStartAfterId,
              startAfter: nextStartAfter,
              cursor: [nextStartAfter, nextStartAfterId],
              lastActivity: new Date().toISOString(),
              canResume: true,
              runningTotal: runningFetched,
              stageOnly: true,
              functionVersion: FUNCTION_VERSION,
              chainScheduledAt: new Date().toISOString(),
              maxPagesPerInvocation: maxPagesToProcess
            }
          })
          .eq('id', syncRunId)
          // Don't override user cancellation
          .in('status', ['running', 'continuing'])
          .select('id');

        if (!chainRows || chainRows.length === 0) {
          logger.info('Sync not updated for chaining (likely cancelled); stopping', { syncRunId });
          return new Response(
            JSON.stringify({ ok: false, status: 'cancelled', error: 'Sync was cancelled by user', syncRunId, version: FUNCTION_VERSION }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const invokeNextChunk = async () => {
          const payload = JSON.stringify({
            syncRunId,
            stageOnly: true,
            startAfterId: nextStartAfterId,
            startAfter: nextStartAfter,
            accumulatedFetched: runningFetched,
            accumulatedInserted: runningInserted,
            maxPages: maxPagesToProcess
          });

          await delay(500); // Small delay to reduce chain burst / gateway throttling

          for (let attempt = 1; attempt <= CHAIN_RETRY_ATTEMPTS; attempt++) {
            try {
              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
                'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? supabaseKey
              };

              const response = await fetchWithTimeout(
                nextChunkUrl,
                { method: 'POST', headers, body: payload },
                CHAIN_FETCH_TIMEOUT_MS
              );

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
                  startAfterId: nextStartAfterId,
                  startAfter: nextStartAfter,
                  cursor: [nextStartAfter, nextStartAfterId],
                  lastActivity: new Date().toISOString(),
                  canResume: true,
                  runningTotal: runningFetched,
                  stageOnly: true,
                  chainFailed: true,
                  functionVersion: FUNCTION_VERSION,
	                  maxPagesPerInvocation: maxPagesToProcess
	                }
	              })
	              .eq('id', syncRunId)
	              // Don't override user cancellation
	              .in('status', ['running', 'continuing']);
	          } catch (updateErr) {
	            logger.error('Failed to mark sync as paused after chain failure', updateErr instanceof Error ? updateErr : new Error(String(updateErr)), { syncRunId });
	          }
	        };

        if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
          EdgeRuntime.waitUntil(invokeNextChunk());
        } else {
          // If waitUntil isn't available, we can't reliably continue in background.
	          await supabase
	            .from('sync_runs')
	            .update({
	              status: 'paused',
              error_message: 'Continuación automática no disponible en este runtime. Usa Reanudar para continuar.',
              checkpoint: {
                startAfterId: nextStartAfterId,
                startAfter: nextStartAfter,
                cursor: [nextStartAfter, nextStartAfterId],
                lastActivity: new Date().toISOString(),
                canResume: true,
                runningTotal: runningFetched,
                stageOnly: true,
                chainFailed: true,
                functionVersion: FUNCTION_VERSION,
	                maxPagesPerInvocation: maxPagesToProcess
	              }
	            })
	            .eq('id', syncRunId)
	            // Don't override user cancellation
	            .in('status', ['running', 'continuing']);

          return new Response(
            JSON.stringify({
              ok: true,
              status: 'paused',
              syncRunId,
              processed: runningFetched,
              staged: runningInserted,
              hasMore: true,
              nextStartAfterId,
              nextStartAfter,
              stageOnly: true,
              backgroundProcessing: false,
              message: 'Sync pausado: no se pudo continuar automáticamente. Usa Reanudar.',
              version: FUNCTION_VERSION
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          status: 'continuing',
          syncRunId,
          processed: runningFetched,
          staged: runningInserted,
          hasMore: true,
          nextStartAfterId,
          nextStartAfter,
          stageOnly: true,
          pagesProcessed,
          backgroundProcessing: !noChain,
          message: noChain
            ? 'Client-driven mode: call again with next cursor to continue.'
            : 'Sync continues in background. Check sync_runs for progress.',
          version: FUNCTION_VERSION
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // LEGACY: Full merge mode
    const maxPagesToProcess = Math.min(
      Math.max(
        1,
        Math.floor((typeof maxPages === 'number' && Number.isFinite(maxPages) ? maxPages : DEFAULT_MAX_PAGES_MERGE))
      ),
      MAX_MAX_PAGES
    );
    const invocationDeadline = startTime + INVOCATION_TIME_BUDGET_MS;

    // Determine starting totals (prefer request accumulators; fall back to DB totals for compatibility)
    let runningFetched = accumulatedFetched ?? syncCheck?.total_fetched ?? 0;
    let runningInserted = accumulatedInserted ?? syncCheck?.total_inserted ?? 0;
    let runningUpdated = accumulatedUpdated ?? syncCheck?.total_updated ?? 0;
    let runningSkipped = accumulatedSkipped ?? syncCheck?.total_skipped ?? 0;
    let runningConflicts = accumulatedConflicts ?? syncCheck?.total_conflicts ?? 0;

    let currentStartAfterId: string | null = startAfterId;
    let currentStartAfter: number | null = startAfter;
    let pagesProcessed = 0;
    let hasMore = true;

    while (hasMore && pagesProcessed < maxPagesToProcess) {
      if (pagesProcessed > 0 && Date.now() > invocationDeadline) {
        logger.warn('Invocation time budget reached; stopping early', { syncRunId, pagesProcessed });
        break;
      }

      // Check if sync was cancelled before fetching next page
      const { data: cancelCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId!)
        .single() as { data: { status: string } | null };

      if (cancelCheck?.status === 'canceled' || cancelCheck?.status === 'cancelled') {
        logger.info('Sync cancelled, stopping', { syncRunId });
        return new Response(
          JSON.stringify({ ok: false, status: 'canceled', error: 'Sync was cancelled by user' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const pageLoopStart = Date.now();
      const pageResult = await processSinglePage(
        supabase as ReturnType<typeof createClient>,
        ghlApiKey,
        ghlLocationId,
        syncRunId!,
        dryRun,
        currentStartAfterId,
        currentStartAfter
      );

      const pageDuration = Date.now() - pageLoopStart;
      logger.info('GHL page processed', {
        duration_ms: pageDuration,
        contactsFetched: pageResult.contactsFetched,
        inserted: pageResult.inserted,
        updated: pageResult.updated,
        skipped: pageResult.skipped,
        conflicts: pageResult.conflicts,
        pageIndex: pagesProcessed + 1,
        maxPages: maxPagesToProcess
      });

      if (pageResult.error) {
        const isRateLimit = isRateLimitErrorMessage(pageResult.error);
        if (isRateLimit) {
          const msg = 'GHL rate limit (429): sync pausado para reintentar luego con Reanudar.';
          await supabase
            .from('sync_runs')
            .update({
              status: 'paused',
              error_message: msg,
              checkpoint: {
                startAfterId: currentStartAfterId,
                startAfter: currentStartAfter,
                cursor: (currentStartAfter !== null && currentStartAfterId) ? [currentStartAfter, currentStartAfterId] : null,
                lastActivity: new Date().toISOString(),
                canResume: true,
                runningTotal: runningFetched,
                stageOnly: false,
                functionVersion: FUNCTION_VERSION,
                maxPagesPerInvocation: maxPagesToProcess
              }
            })
            .eq('id', syncRunId)
            // Don't override user cancellation
            .in('status', ['running', 'continuing']);
          await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
          return new Response(
            JSON.stringify({ ok: false, status: 'paused', syncRunId, error: msg }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        await supabase
          .from('sync_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: pageResult.error })
          .eq('id', syncRunId);
        await writeSyncStateError({ supabase, source: 'ghl', errorMessage: pageResult.error });
        return new Response(JSON.stringify({ ok: false, error: pageResult.error }), { status: 500, headers: corsHeaders });
      }

      runningFetched += pageResult.contactsFetched;
      runningInserted += pageResult.inserted;
      runningUpdated += pageResult.updated;
      runningSkipped += pageResult.skipped;
      runningConflicts += pageResult.conflicts;
      hasMore = pageResult.hasMore;

      if (hasMore) {
        // Guardrail: prevent an infinite loop if pagination cursor is missing or not advancing.
        if (!pageResult.nextStartAfterId || pageResult.nextStartAfter === null) {
          const msg = 'GHL pagination cursor missing; aborting to avoid infinite loop.';
          logger.error(msg, new Error(msg), { syncRunId, currentStartAfterId, currentStartAfter });
          await supabase
            .from('sync_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
            .eq('id', syncRunId);
          await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
          return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
        }
        if (pageResult.nextStartAfterId === currentStartAfterId && pageResult.nextStartAfter === currentStartAfter) {
          const msg = 'GHL pagination cursor did not advance; aborting to avoid infinite loop.';
          logger.error(msg, new Error(msg), { syncRunId, currentStartAfterId, currentStartAfter });
          await supabase
            .from('sync_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
            .eq('id', syncRunId);
          await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
          return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
        }

        currentStartAfterId = pageResult.nextStartAfterId;
        currentStartAfter = pageResult.nextStartAfter;
      }

	      const { data: progressRows } = await supabase
	        .from('sync_runs')
	        .update({
	          status: hasMore ? 'continuing' : 'running',
	          total_fetched: runningFetched,
	          total_inserted: runningInserted,
	          total_updated: runningUpdated,
          total_skipped: runningSkipped,
          total_conflicts: runningConflicts,
          checkpoint: {
            startAfterId: currentStartAfterId,
            startAfter: currentStartAfter,
            cursor: (currentStartAfter !== null && currentStartAfterId) ? [currentStartAfter, currentStartAfterId] : null,
            lastActivity: new Date().toISOString(),
            canResume: true,
            runningTotal: runningFetched,
            stageOnly: false,
            functionVersion: FUNCTION_VERSION,
            pagesProcessedThisInvocation: pagesProcessed + 1,
	            maxPagesPerInvocation: maxPagesToProcess,
	            noChainRequested: noChain
	          }
	        })
	        .eq('id', syncRunId)
	        // Don't override user cancellation
	        .in('status', ['running', 'continuing'])
	        .select('id');

	      if (!progressRows || progressRows.length === 0) {
	        logger.info('Sync not active (likely cancelled); stopping', { syncRunId });
	        return new Response(
	          JSON.stringify({ ok: false, status: 'cancelled', error: 'Sync was cancelled by user', syncRunId, version: FUNCTION_VERSION }),
	          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
	        );
	      }

      pagesProcessed++;
      if (!hasMore) break;
    }

	    if (!hasMore) {
	      const { data: completedRows } = await supabase
	        .from('sync_runs')
	        .update({
	          status: 'completed',
	          completed_at: new Date().toISOString(),
          total_fetched: runningFetched,
          total_inserted: runningInserted,
          total_updated: runningUpdated,
          total_skipped: runningSkipped,
	          total_conflicts: runningConflicts,
	          checkpoint: null
	        })
	        .eq('id', syncRunId)
	        // Don't override user cancellation
	        .in('status', ['running', 'continuing'])
	        .select('id');

	      if (!completedRows || completedRows.length === 0) {
	        logger.info('Sync not marked completed (likely cancelled); stopping', { syncRunId });
	        return new Response(
	          JSON.stringify({ ok: false, status: 'cancelled', error: 'Sync was cancelled by user', syncRunId, version: FUNCTION_VERSION }),
	          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
	        );
	      }

      await writeSyncStateSuccess({
        supabase,
        source: 'ghl',
        runId: syncRunId,
        status: 'completed',
        meta: {
          stageOnly: false,
          functionVersion: FUNCTION_VERSION,
          totalFetched: runningFetched,
          totalInserted: runningInserted,
          totalUpdated: runningUpdated,
          totalSkipped: runningSkipped,
          totalConflicts: runningConflicts,
        },
        rangeStart: null,
        rangeEnd: new Date().toISOString(),
      });

      return new Response(
        JSON.stringify({ ok: true, status: 'completed', syncRunId, processed: runningFetched, hasMore: false, version: FUNCTION_VERSION }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const nextStartAfterId = currentStartAfterId;
    const nextStartAfter = currentStartAfter;

	    if (!nextStartAfterId || nextStartAfter === null) {
	      const msg = 'GHL pagination cursor missing after processing; cannot continue.';
	      logger.error(msg, new Error(msg), { syncRunId, nextStartAfterId, nextStartAfter });
	      await supabase
	        .from('sync_runs')
	        .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
	        .eq('id', syncRunId)
	        // Don't override user cancellation
	        .in('status', ['running', 'continuing']);
        await writeSyncStateError({ supabase, source: 'ghl', errorMessage: msg });
	      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: corsHeaders });
	    }

    if (!noChain) {
      const nextChunkUrl = `${supabaseUrl}/functions/v1/sync-ghl`;

	      const { data: chainRows } = await supabase
	        .from('sync_runs')
	        .update({
	          status: 'continuing',
	          checkpoint: {
            startAfterId: nextStartAfterId,
            startAfter: nextStartAfter,
            cursor: [nextStartAfter, nextStartAfterId],
            lastActivity: new Date().toISOString(),
            canResume: true,
            runningTotal: runningFetched,
            stageOnly: false,
            functionVersion: FUNCTION_VERSION,
            chainScheduledAt: new Date().toISOString(),
	            maxPagesPerInvocation: maxPagesToProcess
	          }
	        })
	        .eq('id', syncRunId)
	        // Don't override user cancellation
	        .in('status', ['running', 'continuing'])
	        .select('id');

	      if (!chainRows || chainRows.length === 0) {
	        logger.info('Sync not updated for chaining (likely cancelled); stopping', { syncRunId });
	        return new Response(
	          JSON.stringify({ ok: false, status: 'cancelled', error: 'Sync was cancelled by user', syncRunId, version: FUNCTION_VERSION }),
	          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
	        );
	      }

      const invokeNextChunk = async () => {
        const payload = JSON.stringify({
          syncRunId,
          stageOnly: false,
          startAfterId: nextStartAfterId,
          startAfter: nextStartAfter,
          dry_run: dryRun,
          accumulatedFetched: runningFetched,
          accumulatedInserted: runningInserted,
          accumulatedUpdated: runningUpdated,
          accumulatedSkipped: runningSkipped,
          accumulatedConflicts: runningConflicts,
          maxPages: maxPagesToProcess
        });

        await delay(500);

        for (let attempt = 1; attempt <= CHAIN_RETRY_ATTEMPTS; attempt++) {
          try {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
              'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? supabaseKey
            };

            const response = await fetchWithTimeout(
              nextChunkUrl,
              { method: 'POST', headers, body: payload },
              CHAIN_FETCH_TIMEOUT_MS
            );

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
            await delay(2000 * attempt);
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
                startAfterId: nextStartAfterId,
                startAfter: nextStartAfter,
                cursor: [nextStartAfter, nextStartAfterId],
                lastActivity: new Date().toISOString(),
                canResume: true,
                runningTotal: runningFetched,
                stageOnly: false,
                chainFailed: true,
                functionVersion: FUNCTION_VERSION,
	                maxPagesPerInvocation: maxPagesToProcess
	              }
	            })
	            .eq('id', syncRunId)
	            // Don't override user cancellation
	            .in('status', ['running', 'continuing']);
	        } catch (updateErr) {
	          logger.error('Failed to mark sync as paused after chain failure', updateErr instanceof Error ? updateErr : new Error(String(updateErr)), { syncRunId });
	        }
	      };

      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(invokeNextChunk());
      } else {
	        await supabase
	          .from('sync_runs')
	          .update({
	            status: 'paused',
	            error_message: 'Continuación automática no disponible en este runtime. Usa Reanudar para continuar.',
            checkpoint: {
              startAfterId: nextStartAfterId,
              startAfter: nextStartAfter,
              cursor: [nextStartAfter, nextStartAfterId],
              lastActivity: new Date().toISOString(),
              canResume: true,
              runningTotal: runningFetched,
              stageOnly: false,
              chainFailed: true,
              functionVersion: FUNCTION_VERSION,
	              maxPagesPerInvocation: maxPagesToProcess
	            }
	          })
	          .eq('id', syncRunId)
	          // Don't override user cancellation
	          .in('status', ['running', 'continuing']);

        return new Response(
          JSON.stringify({
            ok: true,
            status: 'paused',
            syncRunId,
            processed: runningFetched,
            hasMore: true,
            nextStartAfterId,
            nextStartAfter,
            backgroundProcessing: false,
            message: 'Sync pausado: no se pudo continuar automáticamente. Usa Reanudar.',
            version: FUNCTION_VERSION
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: 'continuing',
        syncRunId,
        processed: runningFetched,
        hasMore: true,
        nextStartAfterId,
        nextStartAfter,
        pagesProcessed,
        backgroundProcessing: !noChain,
        message: noChain
          ? 'Client-driven mode: call again with next cursor to continue.'
          : 'Sync continues in background.',
        version: FUNCTION_VERSION
      }),
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
	          .eq('id', syncRunId)
	          // Don't override user cancellation
	          .in('status', ['running', 'continuing']);
	        logger.info('Marked sync run as failed', { id: syncRunId });
          await writeSyncStateError({ supabase, source: 'ghl', errorMessage });
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
