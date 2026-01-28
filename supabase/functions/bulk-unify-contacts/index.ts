// Edge Function: bulk-unify-contacts v2
// High-performance batch unification for 850k+ contacts
// OPTIMIZED: Larger batches, parallel processing, bulk operations only

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
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = ReturnType<typeof createClient<any>>;

// ============ LOGGING ============
function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  console[level](`[${timestamp}] [bulk-unify] ${message}`, data ? JSON.stringify(data) : '');
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

// ============ GET PENDING COUNTS ============
async function getPendingCounts(supabase: SupabaseClient): Promise<{
  ghl: number;
  manychat: number;
  csv: number;
  total: number;
}> {
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
async function processGHLBatch(supabase: SupabaseClient, batchSize: number): Promise<{ processed: number; merged: number; hasMore: boolean }> {
  // Fetch unprocessed
  const { data: rawContacts, error } = await supabase
    .from('ghl_contacts_raw')
    .select('id, external_id, payload')
    .is('processed_at', null)
    .limit(batchSize);

  if (error || !rawContacts?.length) {
    return { processed: 0, merged: 0, hasMore: false };
  }

  const contacts = rawContacts as Array<{ id: string; external_id: string; payload: Record<string, unknown> }>;
  log('info', `Processing GHL batch: ${contacts.length}`);

  // Build client records map (deduplicate by email)
  const emailMap = new Map<string, Record<string, unknown>>();
  const phoneOnlyRecords: Record<string, unknown>[] = [];
  const processedIds: string[] = [];

  for (const contact of contacts) {
    processedIds.push(contact.id);
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
        // Merge tags
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
  
  // Bulk upsert email-based contacts
  const emailRecords = [...emailMap.values()];
  if (emailRecords.length > 0) {
    const { error: upsertError } = await supabase
      .from('clients')
      .upsert(emailRecords, { onConflict: 'email', ignoreDuplicates: false });
    
    if (upsertError) {
      log('error', 'GHL upsert error', upsertError.message);
    } else {
      merged += emailRecords.length;
    }
  }

  // Bulk upsert phone-only contacts (use RPC or direct insert)
  if (phoneOnlyRecords.length > 0) {
    // Try bulk insert, ignore duplicates
    const { error: insertError, count } = await supabase
      .from('clients')
      .upsert(phoneOnlyRecords.map(r => ({ ...r, email: null })), { 
        onConflict: 'phone_e164',
        ignoreDuplicates: true 
      });
    
    if (!insertError) merged += count || phoneOnlyRecords.length;
  }

  // Mark all as processed
  if (processedIds.length > 0) {
    await supabase
      .from('ghl_contacts_raw')
      .update({ processed_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  return { processed: contacts.length, merged, hasMore: contacts.length >= batchSize };
}

// ============ PROCESS MANYCHAT BATCH ============
async function processManyChatBatch(supabase: SupabaseClient, batchSize: number): Promise<{ processed: number; merged: number; hasMore: boolean }> {
  const { data: rawContacts, error } = await supabase
    .from('manychat_contacts_raw')
    .select('id, subscriber_id, payload')
    .is('processed_at', null)
    .limit(batchSize);

  if (error || !rawContacts?.length) {
    return { processed: 0, merged: 0, hasMore: false };
  }

  const contacts = rawContacts as Array<{ id: string; subscriber_id: string; payload: Record<string, unknown> }>;
  log('info', `Processing ManyChat batch: ${contacts.length}`);

  const emailMap = new Map<string, Record<string, unknown>>();
  const phoneOnlyRecords: Record<string, unknown>[] = [];
  const processedIds: string[] = [];

  for (const contact of contacts) {
    processedIds.push(contact.id);
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
  
  const emailRecords = [...emailMap.values()];
  if (emailRecords.length > 0) {
    const { error: upsertError } = await supabase
      .from('clients')
      .upsert(emailRecords, { onConflict: 'email', ignoreDuplicates: false });
    
    if (!upsertError) merged += emailRecords.length;
  }

  if (phoneOnlyRecords.length > 0) {
    const { error: insertError } = await supabase
      .from('clients')
      .upsert(phoneOnlyRecords.map(r => ({ ...r, email: null })), { 
        onConflict: 'phone_e164',
        ignoreDuplicates: true 
      });
    
    if (!insertError) merged += phoneOnlyRecords.length;
  }

  if (processedIds.length > 0) {
    await supabase
      .from('manychat_contacts_raw')
      .update({ processed_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  return { processed: contacts.length, merged, hasMore: contacts.length >= batchSize };
}

// ============ PROCESS CSV BATCH ============
async function processCSVBatch(supabase: SupabaseClient, batchSize: number): Promise<{ processed: number; merged: number; hasMore: boolean }> {
  const { data: rawContacts, error } = await supabase
    .from('csv_imports_raw')
    .select('id, email, phone, full_name, raw_data, source_type')
    .in('processing_status', ['staged', 'pending'])
    .limit(batchSize);

  if (error || !rawContacts?.length) {
    return { processed: 0, merged: 0, hasMore: false };
  }

  const contacts = rawContacts as Array<{
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    raw_data: Record<string, string>;
    source_type: string;
  }>;
  
  log('info', `Processing CSV batch: ${contacts.length}`);

  const emailMap = new Map<string, Record<string, unknown>>();
  const phoneOnlyRecords: Record<string, unknown>[] = [];
  const processedIds: string[] = [];

  for (const contact of contacts) {
    processedIds.push(contact.id);
    
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    if (!email && !phone) continue;

    const raw = contact.raw_data || {};
    
    // Extract IDs from raw data (case-insensitive search)
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

    // Parse total spend
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
        // Merge
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
  
  const emailRecords = [...emailMap.values()];
  if (emailRecords.length > 0) {
    const { error: upsertError } = await supabase
      .from('clients')
      .upsert(emailRecords, { onConflict: 'email', ignoreDuplicates: false });
    
    if (!upsertError) merged += emailRecords.length;
    else log('error', 'CSV upsert error', upsertError.message);
  }

  if (phoneOnlyRecords.length > 0) {
    const { error: insertError } = await supabase
      .from('clients')
      .upsert(phoneOnlyRecords.map(r => ({ ...r, email: null })), { 
        onConflict: 'phone_e164',
        ignoreDuplicates: true 
      });
    
    if (!insertError) merged += phoneOnlyRecords.length;
  }

  // Mark as merged
  if (processedIds.length > 0) {
    await supabase
      .from('csv_imports_raw')
      .update({ processing_status: 'merged', processed_at: new Date().toISOString() })
      .in('id', processedIds);
  }

  return { processed: contacts.length, merged, hasMore: contacts.length >= batchSize };
}

// ============ BACKGROUND WORKER ============
async function runBulkUnification(
  supabaseUrl: string,
  supabaseKey: string,
  syncRunId: string,
  sources: ('ghl' | 'manychat' | 'csv')[],
  batchSize: number,
  totalPending: number
): Promise<void> {
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  let totalProcessed = 0;
  let totalMerged = 0;
  let hasMoreWork = true;
  let iterations = 0;
  const MAX_ITERATIONS = 50000; // Support 5M+ records with batch 100
  const startTime = Date.now();
  let lastProgressUpdate = Date.now();
  let consecutiveEmptyBatches = 0;
  const MAX_EMPTY_BATCHES = 3;

  log('info', 'Starting bulk unification', { syncRunId, sources, batchSize, totalPending });

  try {
    while (hasMoreWork && iterations < MAX_ITERATIONS) {
      iterations++;
      hasMoreWork = false;
      let batchProcessed = 0;

      // Check if cancelled
      const { data: syncCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId)
        .single();
      
      const syncStatus = (syncCheck as { status: string } | null)?.status;
      if (syncStatus === 'cancelled' || syncStatus === 'canceled') {
        log('info', 'Unification cancelled by user');
        break;
      }

      // Process each source in parallel for speed
      const results = await Promise.all(
        sources.map(async (source) => {
          switch (source) {
            case 'ghl': return processGHLBatch(supabase, batchSize);
            case 'manychat': return processManyChatBatch(supabase, batchSize);
            case 'csv': return processCSVBatch(supabase, batchSize);
            default: return { processed: 0, merged: 0, hasMore: false };
          }
        })
      );

      for (const result of results) {
        totalProcessed += result.processed;
        totalMerged += result.merged;
        batchProcessed += result.processed;
        if (result.hasMore) hasMoreWork = true;
      }

      // Track empty batches to detect completion
      if (batchProcessed === 0) {
        consecutiveEmptyBatches++;
        if (consecutiveEmptyBatches >= MAX_EMPTY_BATCHES) {
          log('info', 'No more records to process, finishing');
          hasMoreWork = false;
        }
      } else {
        consecutiveEmptyBatches = 0;
      }

      // Update progress every 5 iterations or 5 seconds
      const now = Date.now();
      if (iterations % 5 === 0 || now - lastProgressUpdate > 5000) {
        lastProgressUpdate = now;
        const elapsedMs = now - startTime;
        const rate = totalProcessed > 0 ? (totalProcessed / (elapsedMs / 1000)).toFixed(1) : '0';
        const progressPct = totalPending > 0 ? Math.min((totalProcessed / totalPending) * 100, 100) : 0;
        const estimatedRemaining = totalProcessed > 0 
          ? Math.round(((totalPending - totalProcessed) / totalProcessed) * elapsedMs / 1000)
          : 0;

        await supabase
          .from('sync_runs')
          .update({
            status: hasMoreWork ? 'continuing' : 'completing',
            total_fetched: totalProcessed,
            total_inserted: totalMerged,
            checkpoint: {
              iterations,
              progressPct: Math.round(progressPct * 10) / 10,
              rate: `${rate}/s`,
              estimatedRemainingSeconds: estimatedRemaining,
              lastUpdate: new Date().toISOString()
            }
          })
          .eq('id', syncRunId);

        // Log progress every 20 iterations
        if (iterations % 20 === 0) {
          log('info', `Progress: ${totalProcessed}/${totalPending} (${progressPct.toFixed(1)}%) - ${rate}/s - ETA: ${Math.round(estimatedRemaining / 60)}m`);
        }
      }

      // Small delay to prevent overwhelming the database (only if we processed something)
      if (hasMoreWork && batchProcessed > 0) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    // Final update
    const elapsedMs = Date.now() - startTime;
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalProcessed,
        total_inserted: totalMerged,
        metadata: {
          sources,
          iterations,
          durationMs: elapsedMs,
          rate: `${(totalProcessed / (elapsedMs / 1000)).toFixed(1)}/s`
        }
      })
      .eq('id', syncRunId);

    log('info', 'Bulk unification completed', { totalProcessed, totalMerged, iterations, durationMs: elapsedMs });

  } catch (error) {
    log('error', 'Bulk unification error', error instanceof Error ? error.message : String(error));
    
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

  try {
    const auth = await verifyAdmin(req);
    if (!auth.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: UnifyRequest = await req.json().catch(() => ({}));
    // OPTIMIZED: Increased batch size to 500 for higher throughput
    const { sources = ['ghl', 'manychat', 'csv'], batchSize = 500, forceCancel = false } = body;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Handle force cancel
    if (forceCancel) {
      const { count } = await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled by user'
        })
        .eq('source', 'bulk_unify')
        .in('status', ['running', 'continuing', 'completing']);

      return new Response(
        JSON.stringify({ ok: true, message: 'Cancelled', cancelled: count || 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check for existing running sync
    const { data: existingSync } = await supabase
      .from('sync_runs')
      .select('id, status, started_at, checkpoint')
      .eq('source', 'bulk_unify')
      .in('status', ['running', 'continuing', 'completing'])
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    if (existingSync) {
      const syncData = existingSync as { 
        id: string; 
        status: string; 
        started_at: string;
        checkpoint: { lastUpdate?: string } | null;
      };
      
      const lastActivity = syncData.checkpoint?.lastUpdate 
        ? new Date(syncData.checkpoint.lastUpdate).getTime()
        : new Date(syncData.started_at).getTime();
      
      // Stale threshold: 3 minutes without activity
      const staleThreshold = 3 * 60 * 1000;
      const inactiveMinutes = Math.round((Date.now() - lastActivity) / 60000);
      
      if (Date.now() - lastActivity > staleThreshold) {
        log('info', `Cancelling stale sync: ${syncData.id} (inactive ${inactiveMinutes}m)`);
        await supabase
          .from('sync_runs')
          .update({ 
            status: 'cancelled', 
            completed_at: new Date().toISOString(),
            error_message: `Stale: inactive ${inactiveMinutes}m - auto-resuming` 
          })
          .eq('id', syncData.id);
        // Continue to start new sync
      } else {
        return new Response(
          JSON.stringify({ 
            ok: true, 
            message: 'Unification in progress',
            syncRunId: syncData.id,
            status: syncData.status,
            lastActivity: syncData.checkpoint?.lastUpdate || syncData.started_at
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Get pending counts
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
        checkpoint: { lastUpdate: new Date().toISOString(), iterations: 0 }
      })
      .select('id')
      .single();

    if (createError || !syncRun) {
      throw new Error(`Failed to create sync run: ${createError?.message}`);
    }

    const syncRunData = syncRun as { id: string };
    log('info', 'Starting bulk unification', { syncRunId: syncRunData.id, pending: pendingCounts });

    // Start background processing
    EdgeRuntime.waitUntil(
      runBulkUnification(
        supabaseUrl, 
        supabaseServiceKey, 
        syncRunData.id, 
        sources, 
        batchSize,
        pendingCounts.total
      )
    );

    // Estimate: 500 records per batch, 3 sources in parallel, ~50 batches per second
    const estimatedMinutes = Math.ceil(pendingCounts.total / (batchSize * 3 * 50));

    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Unification started',
        syncRunId: syncRunData.id,
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
