import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from '../_shared/logger.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('unify-all-sources', LogLevel.INFO);

// Declare EdgeRuntime for Deno
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

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

interface UnifyRequest {
  sources?: ('ghl' | 'manychat' | 'csv')[];
  batchSize?: number;
  syncRunId?: string;
  cursor?: string;
  forceCancel?: boolean;
}

interface RawGHLContact {
  id: string;
  external_id: string;
  payload: Record<string, unknown>;
  processed_at: string | null;
}

interface RawManyChatContact {
  id: string;
  subscriber_id: string;
  payload: Record<string, unknown>;
  processed_at: string | null;
}

interface CSVContact {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  raw_data: Record<string, unknown>;
  processing_status: string;
  source_type: string;
}

// ============ PROCESS GHL RAW CONTACTS ============
async function processGHLBatch(
  supabase: any,
  syncRunId: string,
  batchSize: number
): Promise<{
  processed: number;
  inserted: number;
  updated: number;
  conflicts: number;
  errors: number;
  hasMore: boolean;
}> {
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let conflicts = 0;
  let errors = 0;

  const { data: rawContacts, error: fetchError } = await supabase
    .from('ghl_contacts_raw')
    .select('id, external_id, payload, processed_at')
    .is('processed_at', null)
    .limit(batchSize) as { data: RawGHLContact[] | null; error: Error | null };

  if (fetchError) {
    logger.error('Error fetching GHL raw contacts', fetchError);
    return { processed: 0, inserted: 0, updated: 0, conflicts: 0, errors: 1, hasMore: false };
  }

  const contacts = rawContacts || [];
  const hasMore = contacts.length >= batchSize;

  logger.info('Processing GHL batch', { count: contacts.length });

  for (const contact of contacts) {
    try {
      const payload = contact.payload;
      const email = (payload.email as string) || null;
      const phone = (payload.phone as string) || null;
      
      if (!email && !phone) {
        await (supabase as any)
          .from('ghl_contacts_raw')
          .update({ processed_at: new Date().toISOString() })
          .eq('id', contact.id);
        processed++;
        continue;
      }

      const firstName = (payload.firstName as string) || '';
      const lastName = (payload.lastName as string) || '';
      const fullName = (payload.contactName as string) || 
                       [firstName, lastName].filter(Boolean).join(' ') || 
                       null;
      const tags = (payload.tags as string[]) || [];
      
      const dndSettings = payload.dndSettings as Record<string, { status?: string }> | undefined;
      const inboundDndSettings = payload.inboundDndSettings as Record<string, { status?: string }> | undefined;
      const waOptIn = !payload.dnd && (dndSettings?.whatsApp?.status !== 'active' && inboundDndSettings?.whatsApp?.status !== 'active');
      const smsOptIn = !payload.dnd && (dndSettings?.sms?.status !== 'active' && inboundDndSettings?.sms?.status !== 'active');
      const emailOptIn = !payload.dnd && (dndSettings?.email?.status !== 'active' && inboundDndSettings?.email?.status !== 'active');

      const { data: mergeResult, error: mergeError } = await (supabase as any).rpc('merge_contact', {
        p_source: 'ghl',
        p_external_id: contact.external_id,
        p_email: email,
        p_phone: phone,
        p_full_name: fullName,
        p_tags: tags,
        p_wa_opt_in: waOptIn,
        p_sms_opt_in: smsOptIn,
        p_email_opt_in: emailOptIn,
        p_extra_data: payload,
        p_dry_run: false,
        p_sync_run_id: syncRunId
      });

      if (mergeError) {
        logger.error(`Merge error for GHL contact ${contact.external_id}`, mergeError);
        errors++;
      } else {
        const action = (mergeResult as { action?: string })?.action;
        if (action === 'inserted') inserted++;
        else if (action === 'updated') updated++;
        else if (action === 'conflict') conflicts++;
      }

      await (supabase as any)
        .from('ghl_contacts_raw')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', contact.id);
      
      processed++;

    } catch (err) {
      logger.error('Error processing GHL contact', err instanceof Error ? err : new Error(String(err)));
      errors++;
    }
  }

  return { processed, inserted, updated, conflicts, errors, hasMore };
}

// ============ PROCESS MANYCHAT RAW CONTACTS ============
async function processManyChatBatch(
  supabase: any,
  syncRunId: string,
  batchSize: number
): Promise<{
  processed: number;
  inserted: number;
  updated: number;
  conflicts: number;
  errors: number;
  hasMore: boolean;
}> {
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let conflicts = 0;
  let errors = 0;

  const { data: rawContacts, error: fetchError } = await supabase
    .from('manychat_contacts_raw')
    .select('id, subscriber_id, payload, processed_at')
    .is('processed_at', null)
    .limit(batchSize) as { data: RawManyChatContact[] | null; error: Error | null };

  if (fetchError) {
    logger.error('Error fetching ManyChat raw contacts', fetchError);
    return { processed: 0, inserted: 0, updated: 0, conflicts: 0, errors: 1, hasMore: false };
  }

  const contacts = rawContacts || [];
  const hasMore = contacts.length >= batchSize;

  logger.info('Processing ManyChat batch', { count: contacts.length });

  for (const contact of contacts) {
    try {
      const payload = contact.payload;
      const email = (payload.email as string) || null;
      const phone = (payload.phone as string) || (payload.whatsapp_phone as string) || null;
      const fullName = [payload.first_name, payload.last_name].filter(Boolean).join(' ') || 
                       (payload.name as string) || 
                       null;
      const tags = ((payload.tags as Array<{ name?: string } | string>) || []).map(t => 
        typeof t === 'string' ? t : t.name || ''
      );
      const waOptIn = payload.optin_whatsapp === true;
      const smsOptIn = payload.optin_sms === true;
      const emailOptIn = payload.optin_email !== false;

      const { data: mergeResult, error: mergeError } = await (supabase as any).rpc('merge_contact', {
        p_source: 'manychat',
        p_external_id: contact.subscriber_id,
        p_email: email,
        p_phone: phone,
        p_full_name: fullName,
        p_tags: tags,
        p_wa_opt_in: waOptIn,
        p_sms_opt_in: smsOptIn,
        p_email_opt_in: emailOptIn,
        p_extra_data: payload,
        p_dry_run: false,
        p_sync_run_id: syncRunId
      });

      if (mergeError) {
        logger.error(`Merge error for ManyChat contact ${contact.subscriber_id}`, mergeError);
        errors++;
      } else {
        const action = (mergeResult as { action?: string })?.action;
        if (action === 'inserted') inserted++;
        else if (action === 'updated') updated++;
        else if (action === 'conflict') conflicts++;
      }

      await (supabase as any)
        .from('manychat_contacts_raw')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', contact.id);
      
      processed++;

    } catch (err) {
      logger.error('Error processing ManyChat contact', err instanceof Error ? err : new Error(String(err)));
      errors++;
    }
  }

  return { processed, inserted, updated, conflicts, errors, hasMore };
}

// ============ PROCESS CSV RAW CONTACTS ============
async function processCSVBatch(
  supabase: any,
  syncRunId: string,
  batchSize: number
): Promise<{
  processed: number;
  inserted: number;
  updated: number;
  conflicts: number;
  errors: number;
  hasMore: boolean;
}> {
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let conflicts = 0;
  let errors = 0;

  const { data: rawContacts, error: fetchError } = await supabase
    .from('csv_imports_raw')
    .select('id, email, phone, full_name, raw_data, processing_status, source_type')
    .eq('processing_status', 'staged')
    .limit(batchSize) as { data: CSVContact[] | null; error: Error | null };

  if (fetchError) {
    logger.error('Error fetching CSV raw contacts', fetchError);
    return { processed: 0, inserted: 0, updated: 0, conflicts: 0, errors: 1, hasMore: false };
  }

  const contacts = rawContacts || [];
  const hasMore = contacts.length >= batchSize;

  logger.info('Processing CSV batch', { count: contacts.length });

  for (const contact of contacts) {
    try {
      if (!contact.email && !contact.phone) {
        await (supabase as any)
          .from('csv_imports_raw')
          .update({ processing_status: 'skipped', processed_at: new Date().toISOString() })
          .eq('id', contact.id);
        processed++;
        continue;
      }

      const { data: mergeResult, error: mergeError } = await (supabase as any).rpc('merge_contact', {
        p_source: contact.source_type || 'csv',
        p_external_id: contact.id,
        p_email: contact.email,
        p_phone: contact.phone,
        p_full_name: contact.full_name,
        p_tags: [],
        p_wa_opt_in: false,
        p_sms_opt_in: false,
        p_email_opt_in: true,
        p_extra_data: contact.raw_data,
        p_dry_run: false,
        p_sync_run_id: syncRunId
      });

      if (mergeError) {
        logger.error(`Merge error for CSV contact ${contact.id}`, mergeError);
        await (supabase as any)
          .from('csv_imports_raw')
          .update({ 
            processing_status: 'error', 
            error_message: mergeError.message,
            processed_at: new Date().toISOString() 
          })
          .eq('id', contact.id);
        errors++;
      } else {
        const action = (mergeResult as { action?: string; client_id?: string })?.action;
        const clientId = (mergeResult as { client_id?: string })?.client_id;
        
        if (action === 'inserted') inserted++;
        else if (action === 'updated') updated++;
        else if (action === 'conflict') conflicts++;

        await (supabase as any)
          .from('csv_imports_raw')
          .update({ 
            processing_status: 'merged',
            merged_client_id: clientId,
            processed_at: new Date().toISOString() 
          })
          .eq('id', contact.id);
      }
      
      processed++;

    } catch (err) {
      logger.error('Error processing CSV contact', err instanceof Error ? err : new Error(String(err)));
      errors++;
    }
  }

  return { processed, inserted, updated, conflicts, errors, hasMore };
}

// ============ BACKGROUND UNIFICATION TASK ============
async function runUnificationInBackground(
  supabaseUrl: string,
  supabaseKey: string,
  syncRunId: string,
  sources: ('ghl' | 'manychat' | 'csv')[],
  batchSize: number
): Promise<void> {
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  let totalProcessed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalConflicts = 0;
  let totalErrors = 0;
  let hasMoreWork = true;
  let iterations = 0;
  const MAX_ITERATIONS = 1000;

  logger.info('Starting background unification', { sources, batchSize });

  try {
    while (hasMoreWork && iterations < MAX_ITERATIONS) {
      iterations++;
      hasMoreWork = false;

      const { data: syncCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId)
        .single() as { data: { status: string } | null };
      
      if (syncCheck?.status === 'cancelled' || syncCheck?.status === 'canceled') {
        logger.info('Unification cancelled', { syncRunId });
        break;
      }

      for (const source of sources) {
        let result: { processed: number; inserted: number; updated: number; conflicts: number; errors: number; hasMore: boolean };
        
        switch (source) {
          case 'ghl':
            result = await processGHLBatch(supabase, syncRunId, batchSize);
            break;
          case 'manychat':
            result = await processManyChatBatch(supabase, syncRunId, batchSize);
            break;
          case 'csv':
            result = await processCSVBatch(supabase, syncRunId, batchSize);
            break;
          default:
            continue;
        }

        totalProcessed += result.processed;
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        totalConflicts += result.conflicts;
        totalErrors += result.errors;

        if (result.hasMore) {
          hasMoreWork = true;
        }
      }

      await supabase
        .from('sync_runs')
        .update({
          total_fetched: totalProcessed,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_conflicts: totalConflicts,
          checkpoint: {
            iterations,
            lastUpdate: new Date().toISOString()
          }
        })
        .eq('id', syncRunId);

      if (hasMoreWork) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalProcessed,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_conflicts: totalConflicts,
        metadata: {
          sources,
          iterations,
          totalErrors
        }
      })
      .eq('id', syncRunId);

    logger.info('Background unification completed', { 
      totalProcessed, 
      totalInserted, 
      totalUpdated, 
      totalConflicts, 
      totalErrors,
      iterations 
    });

  } catch (error) {
    logger.error('Background unification error', error instanceof Error ? error : new Error(String(error)));
    
    await supabase
      .from('sync_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error)
      })
      .eq('id', syncRunId);
  }
}

// ============ MAIN HANDLER ============
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: UnifyRequest = await req.json().catch(() => ({}));
    const sources = body.sources || ['ghl', 'manychat', 'csv'];
    const batchSize = body.batchSize || 50;
    const forceCancel = body.forceCancel === true;
    let syncRunId = body.syncRunId;

    // ============ FORCE CANCEL ============
    if (forceCancel) {
      const { data: cancelledSyncs } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(), 
          error_message: 'Cancelado forzosamente por usuario' 
        })
        .eq('source', 'unify-all')
        .in('status', ['running', 'continuing'])
        .select('id') as { data: { id: string }[] | null };

      return new Response(
        JSON.stringify({ 
          ok: true,
          status: 'cancelled', 
          cancelled: cancelledSyncs?.length || 0
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ GET PENDING COUNTS ============
    const { count: ghlPending } = await supabase
      .from('ghl_contacts_raw')
      .select('*', { count: 'exact', head: true })
      .is('processed_at', null);

    const { count: manychatPending } = await supabase
      .from('manychat_contacts_raw')
      .select('*', { count: 'exact', head: true })
      .is('processed_at', null);

    const { count: csvPending } = await supabase
      .from('csv_imports_raw')
      .select('*', { count: 'exact', head: true })
      .eq('processing_status', 'staged');

    const pendingCounts = {
      ghl: ghlPending || 0,
      manychat: manychatPending || 0,
      csv: csvPending || 0,
      total: (ghlPending || 0) + (manychatPending || 0) + (csvPending || 0)
    };

    logger.info('Pending counts', pendingCounts);

    if (pendingCounts.total === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 'no_work',
          message: 'No hay registros pendientes de unificar',
          pending: pendingCounts
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ CREATE SYNC RUN ============
    if (!syncRunId) {
      const { data: syncRun, error: syncError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'unify-all',
          status: 'running',
          metadata: { sources, batchSize, pending: pendingCounts }
        })
        .select()
        .single() as { data: { id: string } | null; error: Error | null };

      if (syncError) {
        throw syncError;
      }

      syncRunId = syncRun?.id;
    }

    // ============ START BACKGROUND TASK ============
    EdgeRuntime.waitUntil(
      runUnificationInBackground(supabaseUrl, supabaseKey, syncRunId!, sources, batchSize)
    );

    logger.info('Unification started in background', { syncRunId, sources, pending: pendingCounts });

    return new Response(
      JSON.stringify({
        ok: true,
        status: 'started',
        syncRunId,
        pending: pendingCounts,
        message: `Unificación iniciada en background. ${pendingCounts.total} registros pendientes.`,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
