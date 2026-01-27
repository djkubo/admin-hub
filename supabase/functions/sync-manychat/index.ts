import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { retryWithBackoff, RETRY_CONFIGS, RETRYABLE_ERRORS } from '../_shared/retry.ts';
import { createLogger, LogLevel } from '../_shared/logger.ts';
import { RATE_LIMITERS } from '../_shared/rate-limiter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('sync-manychat', LogLevel.INFO);
const rateLimiter = RATE_LIMITERS.MANYCHAT;

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

interface SyncRequest {
  dry_run?: boolean;
  cursor?: number;
  syncRunId?: string;
  stageOnly?: boolean;
  forceCancel?: boolean;
}

interface ClientRecord {
  id: string;
  email: string | null;
  phone: string | null;
  manychat_subscriber_id: string | null;
}

// ============ STAGE ONLY: Just download and save raw data ============
async function processPageStageOnly(
  supabase: any,
  manychatApiKey: string,
  syncRunId: string,
  cursor: number
): Promise<{
  searched: number;
  fetched: number;
  staged: number;
  hasMore: boolean;
  nextCursor: number;
  error: string | null;
}> {
  let searched = 0;
  let fetched = 0;
  let staged = 0;

  const { data: existingClients, error: clientsError } = await supabase
    .from('clients')
    .select('id, email, phone')
    .not('email', 'is', null)
    .is('manychat_subscriber_id', null)
    .range(cursor, cursor + 99)
    .limit(100) as { data: ClientRecord[] | null; error: Error | null };

  if (clientsError) {
    logger.error('Error fetching clients', clientsError);
    return { searched: 0, fetched: 0, staged: 0, hasMore: false, nextCursor: cursor, error: clientsError.message };
  }

  const emailsToSearch = existingClients?.filter(c => c.email).map(c => ({ id: c.id, email: c.email! })) || [];
  const hasMore = emailsToSearch.length >= 100;
  searched = emailsToSearch.length;

  logger.info('Stage-only: Searching ManyChat for clients', { count: emailsToSearch.length, cursor });

  const PARALLEL_BATCH_SIZE = 5;
  for (let i = 0; i < emailsToSearch.length; i += PARALLEL_BATCH_SIZE) {
    const emailBatch = emailsToSearch.slice(i, i + PARALLEL_BATCH_SIZE);
    
    await Promise.all(
      emailBatch.map(async ({ email }) => {
        try {
          const encodedEmail = encodeURIComponent(email);

          const searchResponse = await retryWithBackoff(
            () => rateLimiter.execute(() =>
              fetch(
                `https://api.manychat.com/fb/subscriber/findBySystemField?field_name=email&field_value=${encodedEmail}`,
                {
                  method: 'GET',
                  headers: {
                    'Authorization': `Bearer ${manychatApiKey}`,
                    'Accept': 'application/json'
                  }
                }
              )
            ),
            {
              ...RETRY_CONFIGS.FAST,
              retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.MANYCHAT, ...RETRYABLE_ERRORS.HTTP]
            }
          );

          if (!searchResponse.ok) {
            return;
          }

          const searchData = await searchResponse.json();

          if (searchData.status !== 'success' || !searchData.data) {
            return;
          }

          const subscriber = searchData.data;
          fetched++;
          
          logger.debug('Found ManyChat subscriber', { subscriberId: subscriber.id, email });

          const { error: upsertError } = await (supabase as any)
            .from('manychat_contacts_raw')
            .upsert({
              subscriber_id: subscriber.id,
              payload: subscriber,
              sync_run_id: syncRunId,
              fetched_at: new Date().toISOString(),
              processed_at: null
            }, { onConflict: 'subscriber_id' });

          if (!upsertError) {
            staged++;
          }

        } catch (subError) {
          logger.error('Error processing email', subError instanceof Error ? subError : new Error(String(subError)), { email });
        }
      })
    );
    
    if (i + PARALLEL_BATCH_SIZE < emailsToSearch.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return {
    searched,
    fetched,
    staged,
    hasMore,
    nextCursor: cursor + 100,
    error: null
  };
}

// ============ LEGACY: Full merge mode ============
async function processPageWithMerge(
  supabase: any,
  manychatApiKey: string,
  syncRunId: string,
  cursor: number,
  dryRun: boolean
): Promise<{
  searched: number;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  conflicts: number;
  hasMore: boolean;
  nextCursor: number;
  error: string | null;
}> {
  let searched = 0;
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  const { data: existingClients, error: clientsError } = await supabase
    .from('clients')
    .select('email, phone, manychat_subscriber_id')
    .not('email', 'is', null)
    .is('manychat_subscriber_id', null)
    .range(cursor, cursor + 99)
    .limit(100) as { data: ClientRecord[] | null; error: Error | null };

  if (clientsError) {
    logger.error('Error fetching clients', clientsError);
    return { searched: 0, fetched: 0, inserted: 0, updated: 0, skipped: 0, conflicts: 0, hasMore: false, nextCursor: cursor, error: clientsError.message };
  }

  const emailsToSearch = existingClients?.filter(c => c.email).map(c => c.email!) || [];
  const hasMore = emailsToSearch.length >= 100;
  searched = emailsToSearch.length;

  logger.info('Found clients to search in ManyChat', { count: emailsToSearch.length });

  const PARALLEL_BATCH_SIZE = 5;
  for (let i = 0; i < emailsToSearch.length; i += PARALLEL_BATCH_SIZE) {
    const emailBatch = emailsToSearch.slice(i, i + PARALLEL_BATCH_SIZE);
    
    await Promise.all(
      emailBatch.map(async (email) => {
        try {
          const encodedEmail = encodeURIComponent(email);

          const searchResponse = await retryWithBackoff(
            () => rateLimiter.execute(() =>
              fetch(
                `https://api.manychat.com/fb/subscriber/findBySystemField?field_name=email&field_value=${encodedEmail}`,
                {
                  method: 'GET',
                  headers: {
                    'Authorization': `Bearer ${manychatApiKey}`,
                    'Accept': 'application/json'
                  }
                }
              )
            ),
            {
              ...RETRY_CONFIGS.FAST,
              retryableErrors: [...RETRYABLE_ERRORS.NETWORK, ...RETRYABLE_ERRORS.MANYCHAT, ...RETRYABLE_ERRORS.HTTP]
            }
          );

          if (!searchResponse.ok) {
            const status = searchResponse.status;
            if (status === 404 || status === 400) {
              skipped++;
              return;
            }
            logger.warn('Search error for email', { email, status });
            skipped++;
            return;
          }

          const searchData = await searchResponse.json();

          if (searchData.status !== 'success' || !searchData.data) {
            skipped++;
            return;
          }

          const subscriber = searchData.data;
          fetched++;
          logger.info('Found subscriber', { subscriberId: subscriber.id, email });

          if (!dryRun) {
            await (supabase as any)
              .from('manychat_contacts_raw')
              .upsert({
                subscriber_id: subscriber.id,
                payload: subscriber,
                sync_run_id: syncRunId,
                fetched_at: new Date().toISOString()
              }, { onConflict: 'subscriber_id' });
          }

          const subEmail = subscriber.email || email;
          const phone = subscriber.phone || subscriber.whatsapp_phone || null;
          const fullName = [subscriber.first_name, subscriber.last_name].filter(Boolean).join(' ') || subscriber.name || null;
          const tags = (subscriber.tags || []).map((t: { name?: string } | string) => typeof t === 'string' ? t : t.name || '');
          const waOptIn = subscriber.optin_whatsapp === true;
          const smsOptIn = subscriber.optin_sms === true;
          const emailOptIn = subscriber.optin_email !== false;

          const { data: mergeResult, error: mergeError } = await (supabase as any).rpc('merge_contact', {
            p_source: 'manychat',
            p_external_id: subscriber.id,
            p_email: subEmail,
            p_phone: phone,
            p_full_name: fullName,
            p_tags: tags,
            p_wa_opt_in: waOptIn,
            p_sms_opt_in: smsOptIn,
            p_email_opt_in: emailOptIn,
            p_extra_data: subscriber,
            p_dry_run: dryRun,
            p_sync_run_id: syncRunId
          });

          if (mergeError) {
            logger.error('Merge error for subscriber', mergeError, { subscriberId: subscriber.id });
            skipped++;
            return;
          }

          const action = (mergeResult as { action?: string })?.action || 'none';
          if (action === 'inserted') inserted++;
          else if (action === 'updated') updated++;
          else if (action === 'conflict') conflicts++;
          else skipped++;

        } catch (subError) {
          logger.error('Error processing email', subError instanceof Error ? subError : new Error(String(subError)), { email });
          skipped++;
        }
      })
    );
    
    if (i + PARALLEL_BATCH_SIZE < emailsToSearch.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return {
    searched,
    fetched,
    inserted,
    updated,
    skipped,
    conflicts,
    hasMore,
    nextCursor: cursor + 100,
    error: null
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: authCheck.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Admin verified via JWT');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const manychatApiKey = Deno.env.get('MANYCHAT_API_KEY');

    if (!manychatApiKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          status: 'error',
          error: 'MANYCHAT_API_KEY required',
          help: 'Add your ManyChat API key in Settings → Secrets'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: SyncRequest = await req.json().catch(() => ({}));
    const dryRun = body.dry_run ?? false;
    const stageOnly = body.stageOnly ?? false;
    const cursor = body.cursor ?? 0;
    const forceCancel = body.forceCancel === true;
    let syncRunId = body.syncRunId;

    // ============ FORCE CANCEL ALL SYNCS ============
    if (forceCancel) {
      const { data: cancelledSyncs, error: cancelError } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(), 
          error_message: 'Cancelado forzosamente por usuario' 
        })
        .eq('source', 'manychat')
        .in('status', ['running', 'continuing'])
        .select('id');

      logger.info('Force cancelled ManyChat syncs', { count: (cancelledSyncs as { id: string }[] | null)?.length || 0, error: cancelError });

      return new Response(
        JSON.stringify({ 
          ok: true,
          success: true, 
          status: 'cancelled', 
          cancelled: (cancelledSyncs as { id: string }[] | null)?.length || 0,
          message: `Se cancelaron ${(cancelledSyncs as { id: string }[] | null)?.length || 0} sincronizaciones de ManyChat` 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Starting ManyChat sync', { dryRun, stageOnly, cursor });

    // Create or update sync run
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'manychat',
          status: 'running',
          dry_run: dryRun,
          metadata: { method: 'subscriber_search_get', stageOnly }
        })
        .select()
        .single();

      if (syncError) {
        logger.error('Failed to create sync run:', syncError);
        throw syncError;
      }

      syncRunId = (syncRun as { id: string }).id;
    }

    if (stageOnly) {
      const result = await processPageStageOnly(supabase, manychatApiKey, syncRunId!, cursor);

      const status = result.hasMore ? 'continuing' : 'completed';
      await supabase
        .from('sync_runs')
        .update({
          status,
          completed_at: result.hasMore ? null : new Date().toISOString(),
          total_fetched: result.fetched,
          total_inserted: result.staged,
          metadata: {
            method: 'subscriber_search_get',
            stageOnly: true,
            emails_searched: result.searched
          }
        })
        .eq('id', syncRunId);

      logger.info('ManyChat stage-only status', { status, staged: result.staged });

      return new Response(
        JSON.stringify({
          ok: true,
          status,
          syncRunId,
          processed: result.fetched,
          staged: result.staged,
          hasMore: result.hasMore,
          nextCursor: result.hasMore ? result.nextCursor.toString() : null,
          stageOnly: true,
          duration_ms: Date.now() - startTime,
          stats: {
            emails_searched: result.searched,
            total_fetched: result.fetched,
            total_staged: result.staged
          },
          message: result.staged === 0
            ? 'No matches found. Make sure your ManyChat subscribers have the same emails as your clients.'
            : `Staged ${result.staged} subscribers. Run unify-all-sources to merge into clients.`
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await processPageWithMerge(supabase, manychatApiKey, syncRunId!, cursor, dryRun);

    const status = result.hasMore ? 'continuing' : 'completed';
    await supabase
      .from('sync_runs')
      .update({
        status,
        completed_at: result.hasMore ? null : new Date().toISOString(),
        total_fetched: result.fetched,
        total_inserted: result.inserted,
        total_updated: result.updated,
        total_skipped: result.skipped,
        total_conflicts: result.conflicts,
        metadata: {
          method: 'subscriber_search_get',
          emails_searched: result.searched
        }
      })
      .eq('id', syncRunId);

    logger.info('ManyChat sync status', { status, fetched: result.fetched, inserted: result.inserted, updated: result.updated });

    return new Response(
      JSON.stringify({
        ok: true,
        status,
        syncRunId,
        processed: result.fetched,
        hasMore: result.hasMore,
        nextCursor: result.hasMore ? result.nextCursor.toString() : null,
        duration_ms: Date.now() - startTime,
        stats: {
          emails_searched: result.searched,
          total_fetched: result.fetched,
          total_inserted: result.inserted,
          total_updated: result.updated,
          total_skipped: result.skipped,
          total_conflicts: result.conflicts
        },
        note: result.fetched === 0
          ? 'No matches found. Make sure your ManyChat subscribers have the same emails as your clients.'
          : `Found ${result.fetched} subscribers matching your client emails.`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Fatal error', error instanceof Error ? error : new Error(String(error)));
    
    return new Response(
      JSON.stringify({
        ok: false,
        status: 'error',
        error: errorMessage,
        duration_ms: Date.now() - startTime
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
