// Edge Function: bulk-unify-contacts v5
// Single Batch Per Invocation - Prevents timeouts via auto-chaining

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

// ============================================================================
// CONFIGURACIÓN v5 - Single Batch Per Invocation (Anti-Timeout)
// ============================================================================
const BATCH_SIZE_DEFAULT = 50; // Reduced from 100 to prevent memory issues

const logger = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : ''),
};

interface UnifyProgress {
  ghlProcessed: number;
  ghlTotal: number;
  mcProcessed: number;
  mcTotal: number;
  csvProcessed: number;
  csvTotal: number;
  phoneInserted: number;
  errors: number;
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = ReturnType<typeof createClient<any>>;

// ============================================================================
// PHONE MERGE LOGIC - Optimized with Pre-fetch (TAREA 3)
// ============================================================================
async function insertPhoneOnlyRecords(
  supabase: SupabaseClient,
  records: Array<{ phone_e164: string; source: string; name?: string; [key: string]: unknown }>
): Promise<{ inserted: number; updated: number; errors: number }> {
  if (!records.length) return { inserted: 0, updated: 0, errors: 0 };
  
  logger.info(`Processing ${records.length} phone-only records`);
  
  // Step 1: Get all existing phones in ONE query
  const allPhones = records.map(r => r.phone_e164).filter(Boolean);
  
  const { data: existingClients, error: fetchError } = await supabase
    .from('clients')
    .select('id, phone_e164, email, name, last_sync')
    .in('phone_e164', allPhones);
  
  if (fetchError) {
    logger.error('Error fetching existing phones', { error: fetchError.message });
    return { inserted: 0, updated: 0, errors: records.length };
  }
  
  // Step 2: Create a map for quick lookup
  const existingPhoneMap = new Map<string, { id: string; email: string | null; name: string | null }>();
  for (const client of (existingClients || [])) {
    if (client.phone_e164) {
      existingPhoneMap.set(client.phone_e164, {
        id: client.id,
        email: client.email,
        name: client.name
      });
    }
  }
  
  // Step 3: Separate into UPDATE vs INSERT
  const toUpdate: Array<{ id: string; name?: string; last_sync: string }> = [];
  const toInsert: Array<Record<string, unknown>> = [];
  
  const now = new Date().toISOString();
  
  for (const record of records) {
    const existing = existingPhoneMap.get(record.phone_e164);
    
    if (existing) {
      // Already exists - only update if we have new data
      const updateData: { id: string; name?: string; last_sync: string } = {
        id: existing.id,
        last_sync: now
      };
      
      // Only update name if current is empty and we have one
      if (!existing.name && record.name) {
        updateData.name = record.name;
      }
      
      toUpdate.push(updateData);
    } else {
      // New record
      toInsert.push({
        phone_e164: record.phone_e164,
        name: record.name || null,
        source: record.source || 'phone_sync',
        lifecycle_stage: 'LEAD',
        created_at: now,
        last_sync: now,
      });
    }
  }
  
  logger.info(`Phone merge: ${toUpdate.length} to update, ${toInsert.length} to insert`);
  
  let updated = 0;
  let inserted = 0;
  let errors = 0;
  
  // Step 4: Bulk UPDATE existing records
  if (toUpdate.length > 0) {
    const UPDATE_BATCH = 100;
    for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH) {
      const batch = toUpdate.slice(i, i + UPDATE_BATCH);
      
      const { error: updateError } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'id' });
      
      if (updateError) {
        logger.error('Error updating phone records', { error: updateError.message, batch: i });
        errors += batch.length;
      } else {
        updated += batch.length;
      }
    }
  }
  
  // Step 5: Bulk INSERT new records
  if (toInsert.length > 0) {
    const INSERT_BATCH = 50;
    for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
      const batch = toInsert.slice(i, i + INSERT_BATCH);
      
      const { error: insertError } = await supabase
        .from('clients')
        .insert(batch);
      
      if (insertError) {
        // If batch insert fails, try one by one
        logger.warn('Batch insert failed, trying individually', { error: insertError.message });
        
        for (const record of batch) {
          const { error: singleError } = await supabase
            .from('clients')
            .insert(record);
          
          if (singleError) {
            logger.warn('Single insert failed', { phone: String(record.phone_e164), error: singleError.message });
            errors++;
          } else {
            inserted++;
          }
        }
      } else {
        inserted += batch.length;
      }
    }
  }
  
  logger.info(`Phone merge complete: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  return { inserted, updated, errors };
}

// ============================================================================
// PROCESS RAW RECORDS FROM STAGING TABLES
// ============================================================================
async function processGHLBatch(
  supabase: SupabaseClient,
  batchSize: number
): Promise<{ processed: number; errors: number }> {
  const { data: rawRecords, error } = await supabase
    .from('ghl_contacts_raw')
    .select('*')
    .is('processed_at', null)
    .order('fetched_at', { ascending: true })
    .limit(batchSize);
  
  if (error || !rawRecords?.length) {
    return { processed: 0, errors: 0 };
  }
  
  logger.info(`Processing ${rawRecords.length} GHL raw records`);
  
  let processed = 0;
  let errors = 0;
  
  for (const raw of rawRecords) {
    try {
      const payload = raw.raw_payload || {};
      
      const { error: unifyError } = await supabase.rpc('unify_identity', {
        p_email: raw.email?.toLowerCase()?.trim() || null,
        p_phone: raw.phone || null,
        p_ghl_id: raw.contact_id || null,
        p_manychat_id: null,
        p_stripe_id: null,
        p_paypal_id: null,
        p_name: raw.name || payload.firstName || null,
        p_source: 'ghl_sync'
      });
      
      if (unifyError) {
        logger.warn('Unify error for GHL record', { id: raw.id, error: unifyError.message });
        errors++;
      } else {
        processed++;
      }
      
      await supabase
        .from('ghl_contacts_raw')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', raw.id);
        
    } catch (e) {
      logger.error('Error processing GHL record', { id: raw.id, error: String(e) });
      errors++;
    }
  }
  
  return { processed, errors };
}

async function processManyChatBatch(
  supabase: SupabaseClient,
  batchSize: number
): Promise<{ processed: number; errors: number }> {
  const { data: rawRecords, error } = await supabase
    .from('manychat_contacts_raw')
    .select('*')
    .is('processed_at', null)
    .order('fetched_at', { ascending: true })
    .limit(batchSize);
  
  if (error || !rawRecords?.length) {
    return { processed: 0, errors: 0 };
  }
  
  logger.info(`Processing ${rawRecords.length} ManyChat raw records`);
  
  let processed = 0;
  let errors = 0;
  
  for (const raw of rawRecords) {
    try {
      const { error: unifyError } = await supabase.rpc('unify_identity', {
        p_email: raw.email?.toLowerCase()?.trim() || null,
        p_phone: raw.phone || null,
        p_ghl_id: null,
        p_manychat_id: raw.subscriber_id || null,
        p_stripe_id: null,
        p_paypal_id: null,
        p_name: raw.name || raw.first_name || null,
        p_source: 'manychat_sync'
      });
      
      if (unifyError) {
        logger.warn('Unify error for ManyChat record', { id: raw.id, error: unifyError.message });
        errors++;
      } else {
        processed++;
      }
      
      await supabase
        .from('manychat_contacts_raw')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', raw.id);
        
    } catch (e) {
      logger.error('Error processing ManyChat record', { id: raw.id, error: String(e) });
      errors++;
    }
  }
  
  return { processed, errors };
}

async function processCSVBatch(
  supabase: SupabaseClient,
  batchSize: number,
  importId?: string
): Promise<{ processed: number; errors: number }> {
  let query = supabase
    .from('csv_imports_raw')
    .select('*')
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(batchSize);
  
  if (importId) {
    query = query.eq('import_id', importId);
  }
  
  const { data: rawRecords, error } = await query;
  
  if (error || !rawRecords?.length) {
    return { processed: 0, errors: 0 };
  }
  
  logger.info(`Processing ${rawRecords.length} CSV raw records`);
  
  let processed = 0;
  let errors = 0;
  
  // Group records by whether they have email or just phone
  const emailRecords: typeof rawRecords = [];
  const phoneOnlyRecords: Array<{ phone_e164: string; source: string; name?: string }> = [];
  
  for (const raw of rawRecords) {
    const payload = raw.raw_row || {};
    const email = raw.email || payload.email || payload.Email || payload.EMAIL;
    const phone = raw.phone || payload.phone || payload.telefono || payload.Phone || payload.TELEFONO;
    
    if (email) {
      emailRecords.push(raw);
    } else if (phone) {
      phoneOnlyRecords.push({
        phone_e164: phone,
        source: 'csv_import',
        name: raw.name || payload.name || payload.nombre || payload.Name || null
      });
    }
  }
  
  // Process email records via unify_identity
  for (const raw of emailRecords) {
    try {
      const payload = raw.raw_row || {};
      
      const { error: unifyError } = await supabase.rpc('unify_identity', {
        p_email: (raw.email || payload.email || payload.Email)?.toLowerCase()?.trim() || null,
        p_phone: raw.phone || payload.phone || payload.telefono || null,
        p_ghl_id: null,
        p_manychat_id: null,
        p_stripe_id: payload.stripe_customer_id || null,
        p_paypal_id: payload.paypal_customer_id || null,
        p_name: raw.name || payload.name || payload.nombre || null,
        p_source: 'csv_import'
      });
      
      if (unifyError) {
        errors++;
      } else {
        processed++;
      }
      
      await supabase
        .from('csv_imports_raw')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', raw.id);
        
    } catch {
      errors++;
    }
  }
  
  // Process phone-only records with optimized batch logic
  if (phoneOnlyRecords.length > 0) {
    const phoneResult = await insertPhoneOnlyRecords(supabase, phoneOnlyRecords);
    processed += phoneResult.inserted + phoneResult.updated;
    errors += phoneResult.errors;
    
    // Mark phone-only CSV records as processed
    const phoneOnlyIds = rawRecords
      .filter(r => {
        const payload = r.raw_row || {};
        const email = r.email || payload.email || payload.Email;
        return !email;
      })
      .map(r => r.id);
    
    if (phoneOnlyIds.length > 0) {
      await supabase
        .from('csv_imports_raw')
        .update({ processed_at: new Date().toISOString() })
        .in('id', phoneOnlyIds);
    }
  }
  
  return { processed, errors };
}

// ============================================================================
// COUNT PENDING RECORDS
// ============================================================================
async function countPendingRecords(supabase: SupabaseClient): Promise<{
  ghl: number;
  manychat: number;
  csv: number;
}> {
  const [ghlResult, mcResult, csvResult] = await Promise.all([
    supabase.from('ghl_contacts_raw').select('id', { count: 'exact', head: true }).is('processed_at', null),
    supabase.from('manychat_contacts_raw').select('id', { count: 'exact', head: true }).is('processed_at', null),
    supabase.from('csv_imports_raw').select('id', { count: 'exact', head: true }).is('processed_at', null),
  ]);
  
  return {
    ghl: ghlResult.count || 0,
    manychat: mcResult.count || 0,
    csv: csvResult.count || 0,
  };
}

// ============================================================================
// UPDATE SYNC RUN PROGRESS
// ============================================================================
async function updateSyncRunProgress(
  supabase: SupabaseClient,
  syncRunId: string,
  progress: UnifyProgress,
  hasMore: boolean
): Promise<void> {
  const totalProcessed = progress.ghlProcessed + progress.mcProcessed + progress.csvProcessed + progress.phoneInserted;
  const totalRecords = progress.ghlTotal + progress.mcTotal + progress.csvTotal;
  
  const status = hasMore ? 'running' : 'completed';
  
  await supabase
    .from('sync_runs')
    .update({
      status,
      processed_count: totalProcessed,
      total_count: totalRecords,
      error_count: progress.errors,
      completed_at: hasMore ? null : new Date().toISOString(),
      checkpoint: {
        ghlProcessed: progress.ghlProcessed,
        mcProcessed: progress.mcProcessed,
        csvProcessed: progress.csvProcessed,
        phoneInserted: progress.phoneInserted,
        lastUpdated: new Date().toISOString()
      }
    })
    .eq('id', syncRunId);
}

// ============================================================================
// AUTO-CHAIN: Invoke next chunk
// ============================================================================
async function invokeNextChunk(
  syncRunId: string,
  batchSize: number,
  currentProgress: UnifyProgress
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  
  logger.info('Auto-chaining to next chunk', { syncRunId, progress: currentProgress });
  
  try {
    await fetch(`${supabaseUrl}/functions/v1/bulk-unify-contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        syncRunId,
        batchSize,
        continueFrom: currentProgress,
        isChainedCall: true
      }),
    });
  } catch (e) {
    logger.error('Failed to auto-chain', { error: String(e) });
  }
}

// ============================================================================
// MAIN HANDLER - Single Batch Per Invocation (TAREA 2)
// ============================================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  try {
    const body = await req.json().catch(() => ({}));
    
    const batchSize = body.batchSize || BATCH_SIZE_DEFAULT;
    let syncRunId = body.syncRunId;
    const isChainedCall = body.isChainedCall === true;
    const continueFrom = body.continueFrom as UnifyProgress | undefined;
    
    logger.info('=== Bulk Unify v5 - Single Batch Mode ===', { 
      batchSize, 
      syncRunId, 
      isChainedCall 
    });
    
    // Get current pending counts
    const pending = await countPendingRecords(supabase);
    const totalPending = pending.ghl + pending.manychat + pending.csv;
    
    logger.info('Pending records', pending);
    
    if (totalPending === 0) {
      // Nothing to process
      if (syncRunId) {
        await supabase
          .from('sync_runs')
          .update({ 
            status: 'completed', 
            completed_at: new Date().toISOString() 
          })
          .eq('id', syncRunId);
      }
      
      return new Response(JSON.stringify({
        ok: true,
        message: 'No pending records to unify',
        hasMore: false
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Create sync run if not chained
    if (!syncRunId) {
      const { data: newRun, error: runError } = await supabase
        .from('sync_runs')
        .insert({
          source: 'bulk_unify',
          status: 'running',
          total_count: totalPending,
          processed_count: 0,
        })
        .select('id')
        .single();
      
      if (runError) {
        throw new Error(`Failed to create sync run: ${runError.message}`);
      }
      
      syncRunId = newRun.id;
      logger.info('Created new sync run', { syncRunId });
    }
    
    // Initialize progress from checkpoint or start fresh
    const progress: UnifyProgress = continueFrom || {
      ghlProcessed: 0,
      ghlTotal: pending.ghl,
      mcProcessed: 0,
      mcTotal: pending.manychat,
      csvProcessed: 0,
      csvTotal: pending.csv,
      phoneInserted: 0,
      errors: 0,
    };
    
    // ========================================================================
    // SINGLE BATCH PROCESSING (The key change for TAREA 2)
    // Process ONE batch from each source, then return immediately
    // ========================================================================
    
    // Process GHL batch
    if (pending.ghl > 0) {
      const ghlResult = await processGHLBatch(supabase, batchSize);
      progress.ghlProcessed += ghlResult.processed;
      progress.errors += ghlResult.errors;
      logger.info('GHL batch done', ghlResult);
    }
    
    // Process ManyChat batch
    if (pending.manychat > 0) {
      const mcResult = await processManyChatBatch(supabase, batchSize);
      progress.mcProcessed += mcResult.processed;
      progress.errors += mcResult.errors;
      logger.info('ManyChat batch done', mcResult);
    }
    
    // Process CSV batch
    if (pending.csv > 0) {
      const csvResult = await processCSVBatch(supabase, batchSize, body.importId);
      progress.csvProcessed += csvResult.processed;
      progress.errors += csvResult.errors;
      logger.info('CSV batch done', csvResult);
    }
    
    // Check if there's more work
    const newPending = await countPendingRecords(supabase);
    const hasMore = (newPending.ghl + newPending.manychat + newPending.csv) > 0;
    
    // Update sync run progress
    await updateSyncRunProgress(supabase, syncRunId, progress, hasMore);
    
    // If more work, schedule next chunk via waitUntil (non-blocking)
    if (hasMore) {
      EdgeRuntime.waitUntil(invokeNextChunk(syncRunId, batchSize, progress));
    }
    
    // Return IMMEDIATELY with current progress
    const totalProcessed = progress.ghlProcessed + progress.mcProcessed + progress.csvProcessed;
    
    return new Response(JSON.stringify({
      ok: true,
      syncRunId,
      hasMore,
      progress: {
        ghl: { processed: progress.ghlProcessed, total: progress.ghlTotal },
        manychat: { processed: progress.mcProcessed, total: progress.mcTotal },
        csv: { processed: progress.csvProcessed, total: progress.csvTotal },
        phones: progress.phoneInserted,
        errors: progress.errors,
      },
      totalProcessed,
      remainingPending: newPending,
      message: hasMore 
        ? `Processed ${totalProcessed} records, continuing in background...` 
        : `Unification complete: ${totalProcessed} records processed`
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Fatal error in bulk-unify-contacts', { error: errorMessage });
    
    return new Response(JSON.stringify({
      ok: false,
      error: errorMessage
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
