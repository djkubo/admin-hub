// Edge Function: bulk-unify-contacts v4
// High-performance batch unification with MICRO-BATCHES for 800k+ contacts
// FIXED: Timeout issues resolved with smaller upserts and retry logic

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

interface UnifyRequest {
  sources?: ('ghl' | 'manychat' | 'csv')[];
  batchSize?: number;
  forceCancel?: boolean;
  // Auto-chain params
  _continuation?: boolean;
  syncRunId?: string;
  cursor?: {
    ghl_last_id?: string;
    manychat_last_id?: string;
    csv_last_id?: string;
  };
  chunkNumber?: number;
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = ReturnType<typeof createClient<any>>;

// ============ CONSTANTS (FIXED FOR STABILITY) ============
const MAX_EXECUTION_TIME_MS = 45_000; // 45 seconds max per chunk
const BATCH_SIZE_DEFAULT = 100; // REDUCED from 2000 to avoid timeouts
const MICRO_BATCH_SIZE = 25; // Upsert in smaller chunks
const BATCH_DELAY_MS = 50; // Slightly more delay for stability
const MAX_RETRY_ATTEMPTS = 3;
const UPSERT_RETRY_DELAY_MS = 500;

// ============ LOGGING ============
function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  console[level](`[${timestamp}] [bulk-unify-v4] ${message}`, data ? JSON.stringify(data) : '');
}

// ============ DELAY HELPER ============
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  // deno-lint-ignore no-explicit-any
  const { data: isAdmin } = await (supabase as any).rpc('is_admin');
  if (!isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true, userId: user.id };
}

// ============ NORMALIZE PHONE ============
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.length < 10) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

// ============ NORMALIZE EMAIL ============
function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.toLowerCase().trim();
  return trimmed.includes('@') ? trimmed : null;
}

// ============ MICRO-BATCH UPSERT WITH RETRY ============
async function upsertWithRetry(
  supabase: SupabaseClient,
  table: string,
  records: Record<string, unknown>[],
  onConflict: string,
  ignoreDuplicates: boolean
): Promise<{ success: number; failed: number; errors: string[] }> {
  const results = { success: 0, failed: 0, errors: [] as string[] };
  
  if (records.length === 0) return results;

  // Split into micro-batches
  for (let i = 0; i < records.length; i += MICRO_BATCH_SIZE) {
    const microBatch = records.slice(i, i + MICRO_BATCH_SIZE);
    let succeeded = false;
    
    // Try upsert with 1 retry
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabase
          .from(table)
          .upsert(microBatch, { onConflict, ignoreDuplicates });
        
        if (!error) {
          results.success += microBatch.length;
          succeeded = true;
          break;
        } else {
          if (attempt === 0) {
            log('warn', `Micro-batch ${i / MICRO_BATCH_SIZE} attempt 1 failed, retrying...`, error.message);
            await delay(UPSERT_RETRY_DELAY_MS);
          } else {
            results.failed += microBatch.length;
            results.errors.push(`Batch ${i / MICRO_BATCH_SIZE}: ${error.message}`);
            log('error', `Micro-batch ${i / MICRO_BATCH_SIZE} failed after retry`, error.message);
          }
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (attempt === 0) {
          log('warn', `Micro-batch ${i / MICRO_BATCH_SIZE} exception, retrying...`, errMsg);
          await delay(UPSERT_RETRY_DELAY_MS);
        } else {
          results.failed += microBatch.length;
          results.errors.push(`Batch ${i / MICRO_BATCH_SIZE}: ${errMsg}`);
          log('error', `Micro-batch ${i / MICRO_BATCH_SIZE} exception after retry`, errMsg);
        }
      }
    }
    
    // Small delay between successful micro-batches to avoid overwhelming DB
    if (succeeded && i + MICRO_BATCH_SIZE < records.length) {
      await delay(10);
    }
  }
  
  return results;
}

// ============ INSERT PHONE-ONLY RECORDS (no unique constraint on phone) ============
async function insertPhoneOnlyRecords(
  supabase: SupabaseClient,
  records: Record<string, unknown>[]
): Promise<{ success: number; failed: number; errors: string[] }> {
  const results = { success: 0, failed: 0, errors: [] as string[] };
  
  if (records.length === 0) return results;

  // For phone-only records, check if phone already exists and skip if so
  for (let i = 0; i < records.length; i += MICRO_BATCH_SIZE) {
    const microBatch = records.slice(i, i + MICRO_BATCH_SIZE);
    
    // Get phones that already exist
    const phones = microBatch.map(r => r.phone_e164 as string).filter(Boolean);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('phone_e164')
      .in('phone_e164', phones);
    
    const existingPhones = new Set((existingClients || []).map(c => c.phone_e164));
    
    // Filter out records with existing phones
    const newRecords = microBatch.filter(r => !existingPhones.has(r.phone_e164 as string));
    
    if (newRecords.length === 0) {
      results.success += microBatch.length; // Count as "processed" even if skipped
      continue;
    }
    
    // Insert only new records
    try {
      const { error } = await supabase
        .from('clients')
        .insert(newRecords);
      
      if (!error) {
        results.success += microBatch.length;
      } else {
        // If insert fails due to conflict, try one by one
        log('warn', `Phone-only batch insert failed, trying individual inserts...`, error.message);
        for (const record of newRecords) {
          const { error: singleError } = await supabase
            .from('clients')
            .insert(record);
          
          if (!singleError) {
            results.success++;
          } else {
            // Skip duplicates silently
            if (!singleError.message.includes('duplicate')) {
              results.failed++;
              results.errors.push(singleError.message);
            } else {
              results.success++; // Count duplicates as processed
            }
          }
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      results.failed += newRecords.length;
      results.errors.push(`Phone batch ${i / MICRO_BATCH_SIZE}: ${errMsg}`);
      log('error', `Phone-only batch exception`, errMsg);
    }
    
    await delay(10);
  }
  
  return results;
}

// ============ GET PENDING COUNTS (using new accurate RPC) ============
async function getPendingCounts(supabase: SupabaseClient): Promise<{
  ghl: number;
  manychat: number;
  csv: number;
  total: number;
}> {
  try {
    // Try the new accurate RPC first
    const { data, error } = await supabase.rpc('get_staging_counts_accurate');
    if (!error && data) {
      const counts = data as Record<string, number>;
      return {
        ghl: counts.ghl_unprocessed || 0,
        manychat: counts.manychat_unprocessed || 0,
        csv: counts.csv_staged || 0,
        total: (counts.ghl_unprocessed || 0) + (counts.manychat_unprocessed || 0) + (counts.csv_staged || 0)
      };
    }
  } catch (e) {
    log('warn', 'get_staging_counts_accurate failed, falling back', e);
  }

  // Fallback to direct queries
  const [ghlResult, manychatResult, csvResult] = await Promise.all([
    supabase.from('ghl_contacts_raw').select('*', { count: 'exact', head: true }).is('processed_at', null),
    supabase.from('manychat_contacts_raw').select('*', { count: 'exact', head: true }).is('processed_at', null),
    supabase.from('csv_imports_raw').select('*', { count: 'exact', head: true }).in('processing_status', ['staged', 'pending'])
  ]);

  const ghl = ghlResult.count || 0;
  const manychat = manychatResult.count || 0;
  const csv = csvResult.count || 0;

  return { ghl, manychat, csv, total: ghl + manychat + csv };
}

// ============ PROCESS GHL BATCH ============
async function processGHLBatch(
  supabase: SupabaseClient, 
  batchSize: number,
  lastId?: string
): Promise<{ processed: number; merged: number; hasMore: boolean; lastId?: string; errors: number }> {
  let query = supabase
    .from('ghl_contacts_raw')
    .select('id, external_id, payload')
    .is('processed_at', null)
    .order('id', { ascending: true })
    .limit(batchSize);

  if (lastId) {
    query = query.gt('id', lastId);
  }

  const { data: rawContacts, error } = await query;

  if (error || !rawContacts?.length) {
    return { processed: 0, merged: 0, hasMore: false, errors: 0 };
  }

  const contacts = rawContacts as Array<{ id: string; external_id: string; payload: Record<string, unknown> }>;

  const emailMap = new Map<string, Record<string, unknown>>();
  const phoneOnlyRecords: Record<string, unknown>[] = [];
  const processedIds: string[] = [];
  let newLastId = lastId;

  for (const contact of contacts) {
    processedIds.push(contact.id);
    newLastId = contact.id;
    const p = contact.payload || {};
    
    const email = normalizeEmail(p.email as string);
    const phone = normalizePhone(p.phone as string);
    if (!email && !phone) continue;

    const firstName = (p.firstName as string) || '';
    const lastName = (p.lastName as string) || '';
    const fullName = (p.contactName as string) || [firstName, lastName].filter(Boolean).join(' ') || null;
    const tags = (p.tags as string[]) || [];
    
    const dndSettings = p.dndSettings as Record<string, { status?: string }> | undefined;
    const waOptIn = !p.dnd && dndSettings?.whatsApp?.status !== 'active';
    const smsOptIn = !p.dnd && dndSettings?.sms?.status !== 'active';
    const emailOptIn = !p.dnd && dndSettings?.email?.status !== 'active';

    const record: Record<string, unknown> = {
      email,
      phone_e164: phone,
      full_name: fullName,
      ghl_contact_id: contact.external_id,
      tags,
      wa_opt_in: waOptIn,
      sms_opt_in: smsOptIn,
      email_opt_in: emailOptIn,
      lifecycle_stage: 'LEAD',
      last_sync: new Date().toISOString()
    };

    if (email) {
      const existing = emailMap.get(email);
      if (existing) {
        const existingTags = (existing.tags as string[]) || [];
        existing.tags = [...new Set([...existingTags, ...tags])];
        if (!existing.phone_e164 && phone) existing.phone_e164 = phone;
      } else {
        emailMap.set(email, record);
      }
    } else if (phone) {
      phoneOnlyRecords.push(record);
    }
  }

  let merged = 0;
  let totalErrors = 0;
  
  // Use micro-batch upsert for email records
  const emailRecords = [...emailMap.values()];
  if (emailRecords.length > 0) {
    const result = await upsertWithRetry(supabase, 'clients', emailRecords, 'email', false);
    merged += result.success;
    totalErrors += result.failed;
  }

  // Insert phone-only records (no unique constraint on phone_e164)
  if (phoneOnlyRecords.length > 0) {
    const result = await insertPhoneOnlyRecords(
      supabase, 
      phoneOnlyRecords.map(r => ({ ...r, email: null }))
    );
    merged += result.success;
    totalErrors += result.failed;
  }

  // Mark as processed
  if (processedIds.length > 0) {
    await supabase
      .from('ghl_contacts_raw')
      .update({ processed_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  return { 
    processed: contacts.length, 
    merged, 
    hasMore: contacts.length >= batchSize,
    lastId: newLastId,
    errors: totalErrors
  };
}

// ============ PROCESS MANYCHAT BATCH ============
async function processManyChatBatch(
  supabase: SupabaseClient, 
  batchSize: number,
  lastId?: string
): Promise<{ processed: number; merged: number; hasMore: boolean; lastId?: string; errors: number }> {
  let query = supabase
    .from('manychat_contacts_raw')
    .select('id, subscriber_id, payload')
    .is('processed_at', null)
    .order('id', { ascending: true })
    .limit(batchSize);

  if (lastId) {
    query = query.gt('id', lastId);
  }

  const { data: rawContacts, error } = await query;

  if (error || !rawContacts?.length) {
    return { processed: 0, merged: 0, hasMore: false, errors: 0 };
  }

  const contacts = rawContacts as Array<{ id: string; subscriber_id: string; payload: Record<string, unknown> }>;

  const emailMap = new Map<string, Record<string, unknown>>();
  const phoneOnlyRecords: Record<string, unknown>[] = [];
  const processedIds: string[] = [];
  let newLastId = lastId;

  for (const contact of contacts) {
    processedIds.push(contact.id);
    newLastId = contact.id;
    const p = contact.payload || {};
    
    const email = normalizeEmail(p.email as string);
    const phone = normalizePhone((p.phone as string) || (p.whatsapp_phone as string));
    if (!email && !phone) continue;

    const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.name as string) || null;
    const tags = ((p.tags as Array<{ name?: string } | string>) || [])
      .map(t => typeof t === 'string' ? t : t.name || '')
      .filter(Boolean);

    const record: Record<string, unknown> = {
      email,
      phone_e164: phone,
      full_name: fullName,
      manychat_subscriber_id: contact.subscriber_id,
      tags,
      wa_opt_in: p.optin_whatsapp === true,
      sms_opt_in: p.optin_sms === true,
      email_opt_in: p.optin_email !== false,
      lifecycle_stage: 'LEAD',
      last_sync: new Date().toISOString()
    };

    if (email) {
      const existing = emailMap.get(email);
      if (existing) {
        const existingTags = (existing.tags as string[]) || [];
        existing.tags = [...new Set([...existingTags, ...tags])];
        if (!existing.phone_e164 && phone) existing.phone_e164 = phone;
        if (!existing.manychat_subscriber_id) existing.manychat_subscriber_id = contact.subscriber_id;
      } else {
        emailMap.set(email, record);
      }
    } else if (phone) {
      phoneOnlyRecords.push(record);
    }
  }

  let merged = 0;
  let totalErrors = 0;
  
  // Use micro-batch upsert for email records
  const emailRecords = [...emailMap.values()];
  if (emailRecords.length > 0) {
    const result = await upsertWithRetry(supabase, 'clients', emailRecords, 'email', false);
    merged += result.success;
    totalErrors += result.failed;
  }

  // Insert phone-only records (no unique constraint on phone_e164)
  if (phoneOnlyRecords.length > 0) {
    const result = await insertPhoneOnlyRecords(
      supabase, 
      phoneOnlyRecords.map(r => ({ ...r, email: null }))
    );
    merged += result.success;
    totalErrors += result.failed;
  }

  // Mark as processed
  if (processedIds.length > 0) {
    await supabase
      .from('manychat_contacts_raw')
      .update({ processed_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  return { 
    processed: contacts.length, 
    merged, 
    hasMore: contacts.length >= batchSize,
    lastId: newLastId,
    errors: totalErrors
  };
}

// ============ PROCESS CSV BATCH ============
async function processCSVBatch(
  supabase: SupabaseClient, 
  batchSize: number,
  lastId?: string
): Promise<{ processed: number; merged: number; hasMore: boolean; lastId?: string; errors: number }> {
  let query = supabase
    .from('csv_imports_raw')
    .select('id, email, phone, full_name, raw_data, source_type')
    .in('processing_status', ['staged', 'pending'])
    .order('id', { ascending: true })
    .limit(batchSize);

  if (lastId) {
    query = query.gt('id', lastId);
  }

  const { data: rawContacts, error } = await query;

  if (error || !rawContacts?.length) {
    return { processed: 0, merged: 0, hasMore: false, errors: 0 };
  }

  const contacts = rawContacts as Array<{
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    raw_data: Record<string, string>;
    source_type: string;
  }>;

  const emailMap = new Map<string, Record<string, unknown>>();
  const phoneOnlyRecords: Record<string, unknown>[] = [];
  const processedIds: string[] = [];
  let newLastId = lastId;

  for (const contact of contacts) {
    processedIds.push(contact.id);
    newLastId = contact.id;
    
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    if (!email && !phone) continue;

    const raw = contact.raw_data || {};
    
    const findValue = (keys: string[]) => {
      for (const key of keys) {
        const lowerKey = key.toLowerCase();
        for (const [k, v] of Object.entries(raw)) {
          if (k.toLowerCase() === lowerKey && v) return v;
        }
      }
      return null;
    };

    const ghlContactId = findValue(['cnt_contact id', 'contact id', 'ghl_contact_id']);
    const stripeCustomerId = findValue(['st_customer id', 'customer', 'stripe_customer_id']);
    const paypalCustomerId = findValue(['pp_payer_id', 'payer id', 'paypal_customer_id']);
    const manychatSubscriberId = findValue(['subscriber_id', 'manychat_subscriber_id']);

    let totalSpend = 0;
    const spendStr = findValue(['auto_total_spend', 'total_spend', 'total spend']) || '0';
    const cleaned = spendStr.replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleaned);
    if (!isNaN(num)) totalSpend = Math.round(num * 100);

    const tags = (findValue(['cnt_tags', 'tags']) || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const record: Record<string, unknown> = {
      email,
      phone_e164: phone,
      full_name: contact.full_name,
      lifecycle_stage: totalSpend > 0 ? 'CUSTOMER' : 'LEAD',
      last_sync: new Date().toISOString()
    };

    if (ghlContactId) record.ghl_contact_id = ghlContactId;
    if (stripeCustomerId) record.stripe_customer_id = stripeCustomerId;
    if (paypalCustomerId) record.paypal_customer_id = paypalCustomerId;
    if (manychatSubscriberId) record.manychat_subscriber_id = manychatSubscriberId;
    if (totalSpend > 0) record.total_spend = totalSpend;
    if (tags.length > 0) record.tags = tags;

    if (email) {
      const existing = emailMap.get(email);
      if (existing) {
        const existingTags = (existing.tags as string[]) || [];
        const newTags = tags;
        existing.tags = [...new Set([...existingTags, ...newTags])];
        
        const existingSpend = (existing.total_spend as number) || 0;
        if (totalSpend > existingSpend) {
          existing.total_spend = totalSpend;
          existing.lifecycle_stage = 'CUSTOMER';
        }
        
        if (!existing.ghl_contact_id && ghlContactId) existing.ghl_contact_id = ghlContactId;
        if (!existing.stripe_customer_id && stripeCustomerId) existing.stripe_customer_id = stripeCustomerId;
        if (!existing.paypal_customer_id && paypalCustomerId) existing.paypal_customer_id = paypalCustomerId;
        if (!existing.manychat_subscriber_id && manychatSubscriberId) existing.manychat_subscriber_id = manychatSubscriberId;
        if (!existing.phone_e164 && phone) existing.phone_e164 = phone;
        if (!existing.full_name && contact.full_name) existing.full_name = contact.full_name;
      } else {
        emailMap.set(email, record);
      }
    } else if (phone) {
      phoneOnlyRecords.push(record);
    }
  }

  let merged = 0;
  let totalErrors = 0;
  
  // Use micro-batch upsert for email records
  const emailRecords = [...emailMap.values()];
  if (emailRecords.length > 0) {
    const result = await upsertWithRetry(supabase, 'clients', emailRecords, 'email', false);
    merged += result.success;
    totalErrors += result.failed;
  }

  // Insert phone-only records (no unique constraint on phone_e164)
  if (phoneOnlyRecords.length > 0) {
    const result = await insertPhoneOnlyRecords(
      supabase, 
      phoneOnlyRecords.map(r => ({ ...r, email: null }))
    );
    merged += result.success;
    totalErrors += result.failed;
  }

  // Mark as processed
  if (processedIds.length > 0) {
    await supabase
      .from('csv_imports_raw')
      .update({ processing_status: 'merged', processed_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  return { 
    processed: contacts.length, 
    merged, 
    hasMore: contacts.length >= batchSize,
    lastId: newLastId,
    errors: totalErrors
  };
}

// ============ AUTO-CHAIN NEXT CHUNK ============
async function invokeNextChunk(
  supabaseUrl: string,
  serviceRoleKey: string,
  syncRunId: string,
  sources: ('ghl' | 'manychat' | 'csv')[],
  batchSize: number,
  cursor: { ghl_last_id?: string; manychat_last_id?: string; csv_last_id?: string },
  chunkNumber: number,
  retryCount = 0
): Promise<void> {
  try {
    log('info', `Auto-chaining chunk ${chunkNumber + 1}`, { cursor });
    
    const response = await fetch(`${supabaseUrl}/functions/v1/bulk-unify-contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        _continuation: true,
        syncRunId,
        sources,
        batchSize,
        cursor,
        chunkNumber: chunkNumber + 1
      })
    });

    if (!response.ok) {
      throw new Error(`Chain invoke failed: ${response.status}`);
    }
  } catch (error) {
    log('error', `Chain invoke error (attempt ${retryCount + 1})`, error);
    
    if (retryCount < MAX_RETRY_ATTEMPTS) {
      // Exponential backoff
      const delayMs = Math.pow(2, retryCount) * 1000;
      await delay(delayMs);
      return invokeNextChunk(supabaseUrl, serviceRoleKey, syncRunId, sources, batchSize, cursor, chunkNumber, retryCount + 1);
    }
    
    // Mark as failed after max retries
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    await supabase
      .from('sync_runs')
      .update({
        status: 'paused',
        error_message: `Chain invoke failed after ${MAX_RETRY_ATTEMPTS} retries`,
        checkpoint: {
          cursor,
          chunkNumber,
          canResume: true,
          pausedAt: new Date().toISOString()
        }
      })
      .eq('id', syncRunId);
  }
}

// ============ PROCESS CHUNK (Main work loop) ============
async function processChunk(
  supabase: SupabaseClient,
  supabaseUrl: string,
  serviceRoleKey: string,
  syncRunId: string,
  sources: ('ghl' | 'manychat' | 'csv')[],
  batchSize: number,
  cursor: { ghl_last_id?: string; manychat_last_id?: string; csv_last_id?: string },
  chunkNumber: number,
  totalPending: number
): Promise<void> {
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalMerged = 0;
  let totalErrors = 0;
  let hasMoreWork = false;
  const currentCursor = { ...cursor };
  let iterations = 0;
  let consecutiveZeroProcessed = 0;

  log('info', `Processing chunk ${chunkNumber}`, { cursor, batchSize });

  try {
    // Process batches until time limit
    while ((Date.now() - startTime) < MAX_EXECUTION_TIME_MS) {
      iterations++;
      
      // Check if cancelled
      const { data: syncCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId)
        .single();
      
      if ((syncCheck as { status: string } | null)?.status === 'cancelled') {
        log('info', 'Unification cancelled by user');
        return;
      }

      // Process all sources in parallel
      const results = await Promise.all(
        sources.map(async (source) => {
          switch (source) {
            case 'ghl': 
              return { source, ...await processGHLBatch(supabase, batchSize, currentCursor.ghl_last_id) };
            case 'manychat': 
              return { source, ...await processManyChatBatch(supabase, batchSize, currentCursor.manychat_last_id) };
            case 'csv': 
              return { source, ...await processCSVBatch(supabase, batchSize, currentCursor.csv_last_id) };
            default: 
              return { source, processed: 0, merged: 0, hasMore: false, errors: 0 };
          }
        })
      );

      let batchProcessed = 0;
      let batchErrors = 0;
      for (const result of results) {
        totalProcessed += result.processed;
        totalMerged += result.merged;
        batchProcessed += result.processed;
        batchErrors += result.errors || 0;
        totalErrors += result.errors || 0;
        
        if (result.hasMore) hasMoreWork = true;
        
        // Update cursors
        if (result.source === 'ghl' && result.lastId) currentCursor.ghl_last_id = result.lastId;
        if (result.source === 'manychat' && result.lastId) currentCursor.manychat_last_id = result.lastId;
        if (result.source === 'csv' && result.lastId) currentCursor.csv_last_id = result.lastId;
      }

      // Get running total from sync_runs
      const { data: currentSync } = await supabase
        .from('sync_runs')
        .select('total_fetched')
        .eq('id', syncRunId)
        .single();
      
      const runningTotal = ((currentSync as { total_fetched: number } | null)?.total_fetched || 0) + batchProcessed;

      // Update progress
      const elapsedMs = Date.now() - startTime;
      const rate = totalProcessed > 0 ? (totalProcessed / (elapsedMs / 1000)).toFixed(1) : '0';
      const progressPct = totalPending > 0 ? Math.min((runningTotal / totalPending) * 100, 100) : 0;
      const estimatedRemaining = totalProcessed > 0 
        ? Math.round(((totalPending - runningTotal) / (totalProcessed / (elapsedMs / 1000))))
        : 0;

      await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: runningTotal,
          total_inserted: totalMerged,
          total_skipped: totalErrors,
          checkpoint: {
            chunk: chunkNumber,
            cursor: currentCursor,
            iterations,
            progressPct: Math.round(progressPct * 10) / 10,
            rate: `${rate}/s`,
            estimatedRemainingSeconds: estimatedRemaining,
            lastActivity: new Date().toISOString(),
            errors: totalErrors
          }
        })
        .eq('id', syncRunId);

      // FIXED: Better detection of "no work" vs "errors"
      if (batchProcessed === 0) {
        consecutiveZeroProcessed++;
        
        // If we get 0 processed twice in a row, double-check pending counts
        if (consecutiveZeroProcessed >= 2) {
          const freshCounts = await getPendingCounts(supabase);
          log('info', `Zero processed ${consecutiveZeroProcessed}x, fresh counts:`, freshCounts);
          
          if (freshCounts.total === 0) {
            // Truly done!
            hasMoreWork = false;
            break;
          } else if (batchErrors > 0) {
            // There are records but we're getting errors - pause for investigation
            log('warn', `Stalled with ${freshCounts.total} pending and ${batchErrors} errors`);
            await supabase
              .from('sync_runs')
              .update({
                status: 'paused',
                error_message: `Processing stalled: ${freshCounts.total} pending, ${batchErrors} errors this batch`,
                checkpoint: {
                  cursor: currentCursor,
                  chunkNumber,
                  canResume: true,
                  pausedAt: new Date().toISOString(),
                  pendingAtPause: freshCounts
                }
              })
              .eq('id', syncRunId);
            return;
          } else {
            // No errors but no progress - something weird, try one more chunk
            hasMoreWork = freshCounts.total > 0;
            break;
          }
        }
      } else {
        consecutiveZeroProcessed = 0;
      }

      // Small delay between batches
      if (hasMoreWork) {
        await delay(BATCH_DELAY_MS);
      }
    }

    // Check if there's more work and we need to chain
    if (hasMoreWork) {
      log('info', `Chunk ${chunkNumber} complete, chaining to next`, { totalProcessed, totalMerged, totalErrors });
      
      // Auto-invoke next chunk in background
      EdgeRuntime.waitUntil(
        invokeNextChunk(
          supabaseUrl,
          serviceRoleKey,
          syncRunId,
          sources,
          batchSize,
          currentCursor,
          chunkNumber
        )
      );
    } else {
      // All done!
      const { data: finalSync } = await supabase
        .from('sync_runs')
        .select('total_fetched, total_inserted, total_skipped')
        .eq('id', syncRunId)
        .single();

      await supabase
        .from('sync_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          metadata: {
            sources,
            finalChunk: chunkNumber,
            totalProcessed: (finalSync as { total_fetched: number } | null)?.total_fetched || 0,
            totalMerged: (finalSync as { total_inserted: number } | null)?.total_inserted || 0,
            totalErrors: (finalSync as { total_skipped: number } | null)?.total_skipped || 0
          }
        })
        .eq('id', syncRunId);

      log('info', 'Bulk unification completed!', { 
        chunkNumber, 
        totalProcessed: (finalSync as { total_fetched: number } | null)?.total_fetched,
        totalErrors: (finalSync as { total_skipped: number } | null)?.total_skipped 
      });
    }

  } catch (error) {
    log('error', 'Chunk processing error', error instanceof Error ? error.message : String(error));
    
    await supabase
      .from('sync_runs')
      .update({
        status: 'paused',
        error_message: error instanceof Error ? error.message : String(error),
        checkpoint: {
          cursor: currentCursor,
          chunkNumber,
          canResume: true,
          pausedAt: new Date().toISOString()
        }
      })
      .eq('id', syncRunId);
  }
}

// ============ MAIN HANDLER ============
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body: UnifyRequest = await req.json().catch(() => ({}));
    const { 
      sources = ['ghl', 'manychat', 'csv'], 
      batchSize = BATCH_SIZE_DEFAULT, 
      forceCancel = false,
      _continuation = false,
      syncRunId: existingSyncRunId,
      cursor = {},
      chunkNumber = 0
    } = body;

    // ============ CONTINUATION MODE ============
    if (_continuation && existingSyncRunId) {
      log('info', `Continuation chunk ${chunkNumber}`, { cursor });
      
      // Get total pending for progress calculation
      const pendingCounts = await getPendingCounts(supabase);
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .select('metadata')
        .eq('id', existingSyncRunId)
        .single();
      
      const metadata = (syncRun as { metadata: { pending?: { total?: number } } } | null)?.metadata;
      const totalPending = metadata?.pending?.total || pendingCounts.total;
      
      // Process in background and return immediately
      EdgeRuntime.waitUntil(
        processChunk(
          supabase,
          supabaseUrl,
          supabaseServiceKey,
          existingSyncRunId,
          sources,
          batchSize,
          cursor,
          chunkNumber,
          totalPending
        )
      );

      return new Response(
        JSON.stringify({ ok: true, message: 'Continuation started', chunk: chunkNumber }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ INITIAL REQUEST - Verify Admin ============
    const auth = await verifyAdmin(req);
    if (!auth.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ FORCE CANCEL ============
    if (forceCancel) {
      const { count } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled by user'
        })
        .eq('source', 'bulk_unify')
        .in('status', ['running', 'continuing', 'completing', 'paused']);

      return new Response(
        JSON.stringify({ ok: true, message: 'Cancelled', cancelled: count || 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ CHECK FOR EXISTING/RESUMABLE SYNC ============
    const { data: existingSync } = await supabase
      .from('sync_runs')
      .select('id, status, started_at, checkpoint')
      .eq('source', 'bulk_unify')
      .in('status', ['running', 'continuing', 'completing', 'paused'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingSync) {
      const syncData = existingSync as { 
        id: string; 
        status: string; 
        started_at: string;
        checkpoint: { lastActivity?: string; canResume?: boolean; cursor?: typeof cursor; chunkNumber?: number } | null;
      };
      
      const lastActivity = syncData.checkpoint?.lastActivity 
        ? new Date(syncData.checkpoint.lastActivity).getTime()
        : new Date(syncData.started_at).getTime();
      
      // Stale threshold: 3 minutes without activity
      const staleThreshold = 3 * 60 * 1000;
      const inactiveMinutes = Math.round((Date.now() - lastActivity) / 60000);
      
      if (syncData.status === 'paused' || Date.now() - lastActivity > staleThreshold) {
        // Resume from checkpoint
        log('info', `Resuming stale/paused sync: ${syncData.id} (inactive ${inactiveMinutes}m)`);
        
        const resumeCursor = syncData.checkpoint?.cursor || {};
        const resumeChunk = syncData.checkpoint?.chunkNumber || 0;
        const pendingCounts = await getPendingCounts(supabase);
        
        await supabase
          .from('sync_runs')
          .update({ 
            status: 'continuing',
            error_message: null,
            checkpoint: {
              ...syncData.checkpoint,
              resumedAt: new Date().toISOString(),
              resumedFromChunk: resumeChunk
            }
          })
          .eq('id', syncData.id);

        // Start processing in background
        EdgeRuntime.waitUntil(
          processChunk(
            supabase,
            supabaseUrl,
            supabaseServiceKey,
            syncData.id,
            sources,
            batchSize,
            resumeCursor,
            resumeChunk,
            pendingCounts.total
          )
        );

        return new Response(
          JSON.stringify({ 
            ok: true, 
            message: 'Resumed from checkpoint',
            syncRunId: syncData.id,
            resumedFromChunk: resumeChunk
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        // Active sync in progress
        return new Response(
          JSON.stringify({ 
            ok: true, 
            message: 'Unification in progress',
            syncRunId: syncData.id,
            status: syncData.status,
            lastActivity: syncData.checkpoint?.lastActivity || syncData.started_at
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ============ START NEW SYNC ============
    const pendingCounts = await getPendingCounts(supabase);
    
    if (pendingCounts.total === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: 'No pending contacts', pending: pendingCounts }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create sync run
    const { data: syncRun, error: createError } = await supabase
      .from('sync_runs')
      .insert({
        source: 'bulk_unify',
        status: 'running',
        metadata: { sources, batchSize, pending: pendingCounts },
        checkpoint: { 
          chunk: 0,
          cursor: {},
          lastActivity: new Date().toISOString() 
        }
      })
      .select('id')
      .single();

    if (createError || !syncRun) {
      throw new Error(`Failed to create sync run: ${createError?.message}`);
    }

    const newSyncRunId = (syncRun as { id: string }).id;
    log('info', 'Starting bulk unification v4', { syncRunId: newSyncRunId, pending: pendingCounts, batchSize });

    // Start background processing
    EdgeRuntime.waitUntil(
      processChunk(
        supabase,
        supabaseUrl,
        supabaseServiceKey,
        newSyncRunId,
        sources,
        batchSize,
        {},
        0,
        pendingCounts.total
      )
    );

    // Estimate: 100 records per batch (reduced), ~100/s rate
    const estimatedSeconds = Math.ceil(pendingCounts.total / 100);
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Unification started (v4 with micro-batches)',
        syncRunId: newSyncRunId,
        pending: pendingCounts,
        estimatedTime: `~${estimatedMinutes} minutes`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    log('error', 'Request error', error instanceof Error ? error.message : String(error));
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
