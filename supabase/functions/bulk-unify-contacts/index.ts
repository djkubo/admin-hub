// Edge Function: bulk-unify-contacts
// High-performance batch unification for 850k+ contacts
// Uses direct SQL batch operations instead of individual RPC calls

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from '../_shared/logger.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('bulk-unify-contacts', LogLevel.INFO);

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

interface UnifyRequest {
  sources?: ('ghl' | 'manychat' | 'csv')[];
  batchSize?: number;
  syncRunId?: string;
  forceCancel?: boolean;
}

interface GHLRawContact {
  id: string;
  external_id: string;
  payload: Record<string, unknown>;
}

interface ManyChatRawContact {
  id: string;
  subscriber_id: string;
  payload: Record<string, unknown>;
}

interface CSVRawContact {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  raw_data: Record<string, string>;
  source_type: string;
}

interface ClientRecord {
  email?: string | null;
  phone_e164?: string | null;
  full_name?: string | null;
  ghl_contact_id?: string | null;
  manychat_subscriber_id?: string | null;
  stripe_customer_id?: string | null;
  paypal_customer_id?: string | null;
  tags?: string[];
  wa_opt_in?: boolean;
  sms_opt_in?: boolean;
  email_opt_in?: boolean;
  lifecycle_stage?: string;
  total_spend?: number;
  last_sync?: string;
}

// deno-lint-ignore no-explicit-any
type AnySupabase = ReturnType<typeof createClient<any>>;

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
  const { data: isAdmin, error: adminError } = await (supabase as any).rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true, userId: user.id };
}

// ============ GET PENDING COUNTS ============
async function getPendingCounts(supabase: AnySupabase): Promise<{
  ghl: number;
  manychat: number;
  csv: number;
  total: number;
}> {
  const [ghlResult, manychatResult, csvResult] = await Promise.all([
    supabase
      .from('ghl_contacts_raw')
      .select('*', { count: 'exact', head: true })
      .is('processed_at', null),
    supabase
      .from('manychat_contacts_raw')
      .select('*', { count: 'exact', head: true })
      .is('processed_at', null),
    supabase
      .from('csv_imports_raw')
      .select('*', { count: 'exact', head: true })
      .in('processing_status', ['staged', 'pending'])
  ]);

  const ghl = ghlResult.count || 0;
  const manychat = manychatResult.count || 0;
  const csv = csvResult.count || 0;

  return { ghl, manychat, csv, total: ghl + manychat + csv };
}

// ============ NORMALIZE PHONE ============
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.length < 10) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

// ============ BATCH PROCESS GHL ============
async function batchProcessGHL(
  supabase: AnySupabase,
  batchSize: number,
  _syncRunId: string
): Promise<{ processed: number; merged: number; hasMore: boolean }> {
  // Fetch batch of unprocessed GHL contacts
  const { data: rawContacts, error: fetchError } = await supabase
    .from('ghl_contacts_raw')
    .select('id, external_id, payload')
    .is('processed_at', null)
    .limit(batchSize);

  if (fetchError) {
    logger.error('Error fetching GHL batch', fetchError);
    return { processed: 0, merged: 0, hasMore: false };
  }

  const contacts = (rawContacts || []) as GHLRawContact[];
  if (contacts.length === 0) {
    return { processed: 0, merged: 0, hasMore: false };
  }

  logger.info(`Processing GHL batch: ${contacts.length} contacts`);

  // Prepare batch data for clients table
  const clientsToUpsert: ClientRecord[] = [];
  const processedIds: string[] = [];

  for (const contact of contacts) {
    const payload = contact.payload || {};
    const email = ((payload.email as string) || '').toLowerCase().trim() || null;
    const phone = (payload.phone as string) || null;
    
    // Skip contacts without email or phone
    if (!email && !phone) {
      processedIds.push(contact.id);
      continue;
    }

    const firstName = (payload.firstName as string) || '';
    const lastName = (payload.lastName as string) || '';
    const fullName = (payload.contactName as string) || 
                     [firstName, lastName].filter(Boolean).join(' ') || null;
    const tags = (payload.tags as string[]) || [];
    
    const dndSettings = payload.dndSettings as Record<string, { status?: string }> | undefined;
    const inboundDndSettings = payload.inboundDndSettings as Record<string, { status?: string }> | undefined;
    const waOptIn = !payload.dnd && (dndSettings?.whatsApp?.status !== 'active' && inboundDndSettings?.whatsApp?.status !== 'active');
    const smsOptIn = !payload.dnd && (dndSettings?.sms?.status !== 'active' && inboundDndSettings?.sms?.status !== 'active');
    const emailOptIn = !payload.dnd && (dndSettings?.email?.status !== 'active' && inboundDndSettings?.email?.status !== 'active');

    const phoneE164 = normalizePhone(phone);

    clientsToUpsert.push({
      email: email,
      phone_e164: phoneE164,
      full_name: fullName,
      ghl_contact_id: contact.external_id,
      tags: tags,
      wa_opt_in: waOptIn,
      sms_opt_in: smsOptIn,
      email_opt_in: emailOptIn,
      lifecycle_stage: 'LEAD',
      last_sync: new Date().toISOString()
    });
    processedIds.push(contact.id);
  }

  // Batch upsert to clients table
  let merged = 0;
  if (clientsToUpsert.length > 0) {
    // Group by email for deduplication
    const emailMap = new Map<string, ClientRecord>();
    const phoneOnlyContacts: ClientRecord[] = [];

    for (const client of clientsToUpsert) {
      if (client.email) {
        const existing = emailMap.get(client.email);
        if (existing) {
          // Merge - keep first GHL ID, merge tags
          const existingTags = existing.tags || [];
          const newTags = client.tags || [];
          existing.tags = [...new Set([...existingTags, ...newTags])];
          if (!existing.phone_e164 && client.phone_e164) {
            existing.phone_e164 = client.phone_e164;
          }
          if (!existing.full_name && client.full_name) {
            existing.full_name = client.full_name;
          }
        } else {
          emailMap.set(client.email, client);
        }
      } else if (client.phone_e164) {
        phoneOnlyContacts.push(client);
      }
    }

    const deduplicatedClients = [...emailMap.values()];
    
    // Upsert email-based clients
    if (deduplicatedClients.length > 0) {
      const { error: upsertError } = await supabase
        .from('clients')
        .upsert(deduplicatedClients as Record<string, unknown>[], { 
          onConflict: 'email',
          ignoreDuplicates: false 
        });

      if (upsertError) {
        logger.error('GHL batch upsert error', upsertError);
      } else {
        merged += deduplicatedClients.length;
      }
    }

    // Handle phone-only contacts separately (need to check for existing)
    for (const client of phoneOnlyContacts) {
      const { data: existing } = await supabase
        .from('clients')
        .select('id')
        .eq('phone_e164', client.phone_e164 as string)
        .limit(1)
        .single();

      if (existing) {
        // Update existing
        await supabase
          .from('clients')
          .update({
            ghl_contact_id: client.ghl_contact_id,
            last_sync: new Date().toISOString()
          } as Record<string, unknown>)
          .eq('id', (existing as { id: string }).id);
      } else {
        // Insert new
        const { error } = await supabase.from('clients').insert(client as Record<string, unknown>);
        if (!error) merged++;
      }
    }
  }

  // Mark all as processed
  if (processedIds.length > 0) {
    await supabase
      .from('ghl_contacts_raw')
      .update({ processed_at: new Date().toISOString() } as Record<string, unknown>)
      .in('id', processedIds);
  }

  return { 
    processed: contacts.length, 
    merged, 
    hasMore: contacts.length >= batchSize 
  };
}

// ============ BATCH PROCESS MANYCHAT ============
async function batchProcessManyChat(
  supabase: AnySupabase,
  batchSize: number,
  _syncRunId: string
): Promise<{ processed: number; merged: number; hasMore: boolean }> {
  const { data: rawContacts, error: fetchError } = await supabase
    .from('manychat_contacts_raw')
    .select('id, subscriber_id, payload')
    .is('processed_at', null)
    .limit(batchSize);

  if (fetchError) {
    logger.error('Error fetching ManyChat batch', fetchError);
    return { processed: 0, merged: 0, hasMore: false };
  }

  const contacts = (rawContacts || []) as ManyChatRawContact[];
  if (contacts.length === 0) {
    return { processed: 0, merged: 0, hasMore: false };
  }

  logger.info(`Processing ManyChat batch: ${contacts.length} contacts`);

  const clientsToUpsert: ClientRecord[] = [];
  const processedIds: string[] = [];

  for (const contact of contacts) {
    const payload = contact.payload || {};
    const email = ((payload.email as string) || '').toLowerCase().trim() || null;
    const phone = (payload.phone as string) || (payload.whatsapp_phone as string) || null;
    const fullName = [payload.first_name, payload.last_name].filter(Boolean).join(' ') || 
                     (payload.name as string) || null;
    const tags = ((payload.tags as Array<{ name?: string } | string>) || []).map(t => 
      typeof t === 'string' ? t : t.name || ''
    ).filter(Boolean);

    // Skip contacts without email or phone
    if (!email && !phone) {
      processedIds.push(contact.id);
      continue;
    }

    const phoneE164 = normalizePhone(phone);

    clientsToUpsert.push({
      email: email,
      phone_e164: phoneE164,
      full_name: fullName,
      manychat_subscriber_id: contact.subscriber_id,
      tags: tags,
      wa_opt_in: payload.optin_whatsapp === true,
      sms_opt_in: payload.optin_sms === true,
      email_opt_in: payload.optin_email !== false,
      lifecycle_stage: 'LEAD',
      last_sync: new Date().toISOString()
    });
    processedIds.push(contact.id);
  }

  let merged = 0;
  if (clientsToUpsert.length > 0) {
    const emailMap = new Map<string, ClientRecord>();
    const phoneOnlyContacts: ClientRecord[] = [];

    for (const client of clientsToUpsert) {
      if (client.email) {
        const existing = emailMap.get(client.email);
        if (existing) {
          const existingTags = existing.tags || [];
          const newTags = client.tags || [];
          existing.tags = [...new Set([...existingTags, ...newTags])];
          if (!existing.phone_e164 && client.phone_e164) {
            existing.phone_e164 = client.phone_e164;
          }
          if (!existing.manychat_subscriber_id && client.manychat_subscriber_id) {
            existing.manychat_subscriber_id = client.manychat_subscriber_id;
          }
        } else {
          emailMap.set(client.email, client);
        }
      } else if (client.phone_e164) {
        phoneOnlyContacts.push(client);
      }
    }

    const deduplicatedClients = [...emailMap.values()];
    
    if (deduplicatedClients.length > 0) {
      const { error: upsertError } = await supabase
        .from('clients')
        .upsert(deduplicatedClients as Record<string, unknown>[], { 
          onConflict: 'email',
          ignoreDuplicates: false 
        });

      if (upsertError) {
        logger.error('ManyChat batch upsert error', upsertError);
      } else {
        merged += deduplicatedClients.length;
      }
    }

    for (const client of phoneOnlyContacts) {
      const { data: existing } = await supabase
        .from('clients')
        .select('id')
        .eq('phone_e164', client.phone_e164 as string)
        .limit(1)
        .single();

      if (existing) {
        await supabase
          .from('clients')
          .update({
            manychat_subscriber_id: client.manychat_subscriber_id,
            last_sync: new Date().toISOString()
          } as Record<string, unknown>)
          .eq('id', (existing as { id: string }).id);
      } else {
        const { error } = await supabase.from('clients').insert(client as Record<string, unknown>);
        if (!error) merged++;
      }
    }
  }

  if (processedIds.length > 0) {
    await supabase
      .from('manychat_contacts_raw')
      .update({ processed_at: new Date().toISOString() } as Record<string, unknown>)
      .in('id', processedIds);
  }

  return { 
    processed: contacts.length, 
    merged, 
    hasMore: contacts.length >= batchSize 
  };
}

// ============ BATCH PROCESS CSV ============
async function batchProcessCSV(
  supabase: AnySupabase,
  batchSize: number,
  _syncRunId: string
): Promise<{ processed: number; merged: number; hasMore: boolean }> {
  const { data: rawContacts, error: fetchError } = await supabase
    .from('csv_imports_raw')
    .select('id, email, phone, full_name, raw_data, source_type')
    .in('processing_status', ['staged', 'pending'])
    .limit(batchSize);

  if (fetchError) {
    logger.error('Error fetching CSV batch', fetchError);
    return { processed: 0, merged: 0, hasMore: false };
  }

  const contacts = (rawContacts || []) as CSVRawContact[];
  if (contacts.length === 0) {
    return { processed: 0, merged: 0, hasMore: false };
  }

  logger.info(`Processing CSV batch: ${contacts.length} contacts`);

  const clientsToUpsert: ClientRecord[] = [];
  const processedIds: string[] = [];

  for (const contact of contacts) {
    const email = (contact.email || '').toLowerCase().trim() || null;
    const phone = contact.phone || null;
    const rawData = contact.raw_data || {};

    // Skip contacts without email or phone
    if (!email && !phone) {
      processedIds.push(contact.id);
      continue;
    }

    const phoneE164 = normalizePhone(phone);

    // Extract IDs from raw data
    const ghlContactId = rawData['cnt_contact id'] || rawData['Contact Id'] || rawData['ghl_contact_id'] || null;
    const stripeCustomerId = rawData['st_customer id'] || rawData['Customer'] || rawData['stripe_customer_id'] || null;
    const paypalCustomerId = rawData['pp_payer_id'] || rawData['Payer Id'] || null;
    const manychatSubscriberId = rawData['subscriber_id'] || rawData['manychat_subscriber_id'] || null;

    // Parse total spend
    let totalSpend = 0;
    const spendStr = rawData['auto_total_spend'] || rawData['total_spend'] || rawData['Total Spend'] || '0';
    const cleaned = spendStr.replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleaned);
    if (!isNaN(num)) totalSpend = Math.round(num * 100);

    const tags = (rawData['cnt_tags'] || rawData['Tags'] || rawData['tags'] || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const clientData: ClientRecord = {
      email: email,
      phone_e164: phoneE164,
      full_name: contact.full_name,
      lifecycle_stage: totalSpend > 0 ? 'CUSTOMER' : 'LEAD',
      last_sync: new Date().toISOString()
    };

    if (ghlContactId) clientData.ghl_contact_id = ghlContactId;
    if (stripeCustomerId) clientData.stripe_customer_id = stripeCustomerId;
    if (paypalCustomerId) clientData.paypal_customer_id = paypalCustomerId;
    if (manychatSubscriberId) clientData.manychat_subscriber_id = manychatSubscriberId;
    if (totalSpend > 0) clientData.total_spend = totalSpend;
    if (tags.length > 0) clientData.tags = tags;

    clientsToUpsert.push(clientData);
    processedIds.push(contact.id);
  }

  let merged = 0;
  if (clientsToUpsert.length > 0) {
    const emailMap = new Map<string, ClientRecord>();
    const phoneOnlyContacts: ClientRecord[] = [];

    for (const client of clientsToUpsert) {
      if (client.email) {
        const existing = emailMap.get(client.email);
        if (existing) {
          // Merge all IDs and tags
          const existingTags = existing.tags || [];
          const newTags = client.tags || [];
          existing.tags = [...new Set([...existingTags, ...newTags])];
          
          // Keep highest spend
          const existingSpend = existing.total_spend || 0;
          const newSpend = client.total_spend || 0;
          if (newSpend > existingSpend) existing.total_spend = newSpend;
          
          // Merge IDs (don't overwrite existing)
          if (!existing.ghl_contact_id && client.ghl_contact_id) existing.ghl_contact_id = client.ghl_contact_id;
          if (!existing.stripe_customer_id && client.stripe_customer_id) existing.stripe_customer_id = client.stripe_customer_id;
          if (!existing.paypal_customer_id && client.paypal_customer_id) existing.paypal_customer_id = client.paypal_customer_id;
          if (!existing.manychat_subscriber_id && client.manychat_subscriber_id) existing.manychat_subscriber_id = client.manychat_subscriber_id;
          if (!existing.phone_e164 && client.phone_e164) existing.phone_e164 = client.phone_e164;
          if (!existing.full_name && client.full_name) existing.full_name = client.full_name;
          
          // Update lifecycle if higher spend
          if (newSpend > 0) existing.lifecycle_stage = 'CUSTOMER';
        } else {
          emailMap.set(client.email, client);
        }
      } else if (client.phone_e164) {
        phoneOnlyContacts.push(client);
      }
    }

    const deduplicatedClients = [...emailMap.values()];
    
    if (deduplicatedClients.length > 0) {
      const { error: upsertError } = await supabase
        .from('clients')
        .upsert(deduplicatedClients as Record<string, unknown>[], { 
          onConflict: 'email',
          ignoreDuplicates: false 
        });

      if (upsertError) {
        logger.error('CSV batch upsert error', upsertError);
      } else {
        merged += deduplicatedClients.length;
      }
    }

    for (const client of phoneOnlyContacts) {
      const { data: existing } = await supabase
        .from('clients')
        .select('id, total_spend')
        .eq('phone_e164', client.phone_e164 as string)
        .limit(1)
        .single();

      if (existing) {
        const existingData = existing as { id: string; total_spend: number | null };
        const updateData: Record<string, unknown> = { last_sync: new Date().toISOString() };
        if (client.ghl_contact_id) updateData.ghl_contact_id = client.ghl_contact_id;
        if (client.stripe_customer_id) updateData.stripe_customer_id = client.stripe_customer_id;
        if (client.paypal_customer_id) updateData.paypal_customer_id = client.paypal_customer_id;
        if (client.manychat_subscriber_id) updateData.manychat_subscriber_id = client.manychat_subscriber_id;
        
        const newSpend = client.total_spend || 0;
        const existingSpend = existingData.total_spend || 0;
        if (newSpend > existingSpend) {
          updateData.total_spend = newSpend;
          updateData.lifecycle_stage = 'CUSTOMER';
        }

        await supabase.from('clients').update(updateData).eq('id', existingData.id);
      } else {
        const { error } = await supabase.from('clients').insert(client as Record<string, unknown>);
        if (!error) merged++;
      }
    }
  }

  // Mark as merged
  if (processedIds.length > 0) {
    await supabase
      .from('csv_imports_raw')
      .update({ 
        processing_status: 'merged',
        processed_at: new Date().toISOString() 
      } as Record<string, unknown>)
      .in('id', processedIds);
  }

  return { 
    processed: contacts.length, 
    merged, 
    hasMore: contacts.length >= batchSize 
  };
}

// ============ BACKGROUND UNIFICATION ============
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
  const MAX_ITERATIONS = 10000; // Support for 850k+ with batch size 100
  const startTime = Date.now();
  
  // NEW: Batch timeout protection
  let lastBatchTime = Date.now();
  const BATCH_TIMEOUT_MS = 120000; // 2 minutes max per batch iteration

  logger.info('Starting bulk unification', { sources, batchSize, totalPending });

  try {
    while (hasMoreWork && iterations < MAX_ITERATIONS) {
      iterations++;
      hasMoreWork = false;
      
      // NEW: Detect batch timeout (stuck processing)
      if (Date.now() - lastBatchTime > BATCH_TIMEOUT_MS) {
        logger.error(`Batch timeout detected after ${iterations} iterations, forcing failure for recovery`);
        throw new Error(`Batch timeout: no progress for ${Math.round(BATCH_TIMEOUT_MS / 1000)}s after ${iterations} iterations`);
      }

      // Check if cancelled
      const { data: syncCheck } = await supabase
        .from('sync_runs')
        .select('status')
        .eq('id', syncRunId)
        .single();
      
      const syncStatus = (syncCheck as { status: string } | null)?.status;
      if (syncStatus === 'cancelled' || syncStatus === 'canceled') {
        logger.info('Unification cancelled by user');
        break;
      }

      // Process each source
      for (const source of sources) {
        let result: { processed: number; merged: number; hasMore: boolean };
        
        switch (source) {
          case 'ghl':
            result = await batchProcessGHL(supabase, batchSize, syncRunId);
            break;
          case 'manychat':
            result = await batchProcessManyChat(supabase, batchSize, syncRunId);
            break;
          case 'csv':
            result = await batchProcessCSV(supabase, batchSize, syncRunId);
            break;
          default:
            continue;
        }

        totalProcessed += result.processed;
        totalMerged += result.merged;

        if (result.hasMore) {
          hasMoreWork = true;
        }
        
        // Reset batch timer after successful processing
        if (result.processed > 0) {
          lastBatchTime = Date.now();
        }
      }

      // Update progress every iteration with lastUpdate timestamp
      const elapsedMs = Date.now() - startTime;
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
            lastUpdate: new Date().toISOString() // Critical for stale detection
          }
        } as Record<string, unknown>)
        .eq('id', syncRunId);

      // Log progress every 10 iterations
      if (iterations % 10 === 0) {
        logger.info(`Progress: ${totalProcessed}/${totalPending} (${progressPct.toFixed(1)}%) - ${rate}/s - ETA: ${estimatedRemaining}s`);
      }

      // Small delay to prevent overwhelming the database
      if (hasMoreWork) {
        await new Promise(resolve => setTimeout(resolve, 50));
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
      } as Record<string, unknown>)
      .eq('id', syncRunId);

    logger.info('Bulk unification completed', { 
      totalProcessed, 
      totalMerged, 
      iterations,
      durationMs: elapsedMs
    });

  } catch (error) {
    logger.error('Bulk unification error', error instanceof Error ? error : new Error(String(error)));
    
    await supabase
      .from('sync_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error)
      } as Record<string, unknown>)
      .eq('id', syncRunId);
  }
}

// ============ MAIN HANDLER ============
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify admin
    const auth = await verifyAdmin(req);
    if (!auth.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: UnifyRequest = await req.json().catch(() => ({}));
    // OPTIMIZED: Reduced batch size from 200 to 100 for stability
    const { sources = ['ghl', 'manychat', 'csv'], batchSize = 100, forceCancel = false } = body;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Handle force cancel
    if (forceCancel) {
      await supabase
        .from('sync_runs')
        .update({ 
          status: 'cancelled', 
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled by user'
        } as Record<string, unknown>)
        .eq('source', 'bulk_unify')
        .in('status', ['running', 'continuing', 'completing']);

      return new Response(
        JSON.stringify({ ok: true, message: 'Cancelled all running unifications' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check for existing running sync - FIXED: Now reads checkpoint for stale detection
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
      
      // FIXED: Use checkpoint.lastUpdate instead of started_at for stale detection
      const lastActivity = syncData.checkpoint?.lastUpdate 
        ? new Date(syncData.checkpoint.lastUpdate).getTime()
        : new Date(syncData.started_at).getTime();
      
      // OPTIMIZED: Reduced stale threshold from 10 to 5 minutes
      const staleThreshold = 5 * 60 * 1000; // 5 minutes without activity
      const inactiveMinutes = Math.round((Date.now() - lastActivity) / 60000);
      
      if (Date.now() - lastActivity > staleThreshold) {
        // Cancel stale sync and allow restart (auto-resume from where it stopped)
        logger.info(`Cancelling stale sync: ${syncData.id} (inactive for ${inactiveMinutes} min)`);
        await supabase
          .from('sync_runs')
          .update({ 
            status: 'cancelled', 
            completed_at: new Date().toISOString(),
            error_message: `Stale: no activity for ${inactiveMinutes} minutes - auto-resuming` 
          } as Record<string, unknown>)
          .eq('id', syncData.id);
        // Continue to start new sync (will resume from unprocessed records)
      } else {
        // Return existing sync info
        return new Response(
          JSON.stringify({ 
            ok: true, 
            message: 'Unification already in progress',
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
        JSON.stringify({ ok: true, message: 'No pending contacts to unify', pending: pendingCounts }),
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
        checkpoint: { lastUpdate: new Date().toISOString(), iterations: 0 } // Start with checkpoint
      } as Record<string, unknown>)
      .select('id')
      .single();

    if (createError || !syncRun) {
      throw new Error(`Failed to create sync run: ${createError?.message}`);
    }

    const syncRunData = syncRun as { id: string };
    logger.info('Starting bulk unification', { syncRunId: syncRunData.id, pending: pendingCounts });

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

    // Return immediately
    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Bulk unification started',
        syncRunId: syncRunData.id,
        pending: pendingCounts,
        estimatedTime: `~${Math.ceil(pendingCounts.total / (batchSize * 10))} minutes`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    logger.error('Request error', error instanceof Error ? error : new Error(String(error)));
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
