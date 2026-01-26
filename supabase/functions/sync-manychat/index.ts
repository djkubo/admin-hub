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
}

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
    const body: SyncRequest & { forceCancel?: boolean } = await req.json().catch(() => ({}));
    const dryRun = body.dry_run ?? false;
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

      logger.info('Force cancelled ManyChat syncs', { count: cancelledSyncs?.length || 0, error: cancelError });

      return new Response(
        JSON.stringify({ 
          ok: true,
          success: true, 
          status: 'cancelled', 
          cancelled: cancelledSyncs?.length || 0,
          message: `Se cancelaron ${cancelledSyncs?.length || 0} sincronizaciones de ManyChat` 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Starting ManyChat sync', { dryRun, cursor });

    // Create or update sync run
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'manychat',
          status: 'running',
          dry_run: dryRun,
          metadata: { method: 'subscriber_search_get' }
        })
        .select()
        .single();

      if (syncError) {
        console.error('[sync-manychat] Failed to create sync run:', syncError);
        throw syncError;
      }

      syncRunId = syncRun.id;
    }

    let totalFetched = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalConflicts = 0;

    // Fetch clients that need ManyChat linking
    const { data: existingClients, error: clientsError } = await supabase
      .from('clients')
      .select('email, phone, manychat_subscriber_id')
      .not('email', 'is', null)
      .is('manychat_subscriber_id', null)
      .range(cursor, cursor + 99)
      .limit(100);

    if (clientsError) {
      logger.error('Error fetching clients', clientsError);
    }

    const emailsToSearch = existingClients?.filter(c => c.email).map(c => c.email!) || [];
    const hasMore = emailsToSearch.length >= 100;

    logger.info('Found clients to search in ManyChat', { count: emailsToSearch.length });

    // Process emails in parallel batches for better performance
    const PARALLEL_BATCH_SIZE = 5; // Process 5 emails in parallel
    for (let i = 0; i < emailsToSearch.length; i += PARALLEL_BATCH_SIZE) {
      const emailBatch = emailsToSearch.slice(i, i + PARALLEL_BATCH_SIZE);
      
      // Process batch in parallel
      await Promise.all(
        emailBatch.map(async (email) => {
          try {
            const encodedEmail = encodeURIComponent(email);

            // Wrap API call with retry + rate limiting
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
                totalSkipped++;
                return; // Skip this email
              }
              logger.warn('Search error for email', { email, status });
              totalSkipped++;
              return; // Skip this email
            }

            const searchData = await searchResponse.json();

            if (searchData.status !== 'success' || !searchData.data) {
              totalSkipped++;
              return; // Skip this email
            }

            const subscriber = searchData.data;
            totalFetched++; // Increment fetched count when we find a subscriber
            logger.info('Found subscriber', { subscriberId: subscriber.id, email });

            if (!dryRun) {
              await supabase
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
            const tags = (subscriber.tags || []).map((t: any) => t.name || t);
            const waOptIn = subscriber.optin_whatsapp === true;
            const smsOptIn = subscriber.optin_sms === true;
            const emailOptIn = subscriber.optin_email !== false;

            const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_contact', {
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
              totalSkipped++;
              return; // Skip this email
            }

            const action = mergeResult?.action || 'none';
            if (action === 'inserted') totalInserted++;
            else if (action === 'updated') totalUpdated++;
            else if (action === 'conflict') totalConflicts++;
            else totalSkipped++;

          } catch (subError) {
            logger.error('Error processing email', subError instanceof Error ? subError : new Error(String(subError)), { email });
            totalSkipped++;
          }
        })
      );
      
      // Small delay between batches to respect rate limits
      if (i + PARALLEL_BATCH_SIZE < emailsToSearch.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Update sync run
    const status = hasMore ? 'continuing' : 'completed';
    await supabase
      .from('sync_runs')
      .update({
        status,
        completed_at: hasMore ? null : new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        metadata: {
          method: 'subscriber_search_get',
          emails_searched: emailsToSearch.length
        }
      })
      .eq('id', syncRunId);

    logger.info('ManyChat sync status', { status, totalFetched, totalInserted, totalUpdated });

    return new Response(
      JSON.stringify({
        ok: true,
        status,
        syncRunId,
        processed: totalFetched,
        hasMore,
        nextCursor: hasMore ? (cursor + 100).toString() : null,
        duration_ms: Date.now() - startTime,
        stats: {
          emails_searched: emailsToSearch.length,
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts
        },
        note: totalFetched === 0
          ? 'No matches found. Make sure your ManyChat subscribers have the same emails as your clients.'
          : `Found ${totalFetched} subscribers matching your client emails.`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Fatal error', error instanceof Error ? error : new Error(String(error)));
    
    // Note: syncRunId and supabase are scoped inside try block
    // Fatal errors at this level mean we couldn't initialize properly
    
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
