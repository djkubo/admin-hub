// Edge Function: process-csv-bulk
// 2-Phase CSV Processor: Staging (sync) + Merge (background)
// Phase 1: Fast staging - data visible immediately
// Phase 2: Background merge - identity unification

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { createLogger, LogLevel } from '../_shared/logger.ts';

// Declare EdgeRuntime for TypeScript
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('process-csv-bulk', LogLevel.INFO);

type CSVType = 'ghl' | 'stripe_payments' | 'stripe_customers' | 'paypal' | 'subscriptions' | 'master' | 'auto';

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

interface StagingResult {
  importId: string;
  staged: number;
  totalRows: number;
  sourceType: string;
  phase: 'staged';
}

interface MergeResult {
  importId: string;
  merged: number;
  conflicts: number;
  errors: number;
  phase: 'merged';
}

interface ProcessingResult {
  csvType: string;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  duration: number;
  ghlContacts?: number;
  stripePayments?: number;
  paypalPayments?: number;
  subscriptions?: number;
  transactionsCreated?: number;
  clientsCreated?: number;
  clientsUpdated?: number;
}

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

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 10) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findColumnIndex(headers: string[], patterns: string[]): number {
  const normalizedHeaders = headers.map(normalizeHeader);
  
  for (const pattern of patterns) {
    const normalizedPattern = normalizeHeader(pattern);
    const exactIdx = normalizedHeaders.findIndex(h => h === normalizedPattern);
    if (exactIdx !== -1) return exactIdx;
    const containsIdx = normalizedHeaders.findIndex(h => h.includes(normalizedPattern));
    if (containsIdx !== -1) return containsIdx;
  }
  
  return -1;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function normalizeAmount(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100);
}

function detectCSVType(headers: string[]): CSVType {
  const normalized = headers.map(h => h.toLowerCase().trim());
  
  const hasCNT = normalized.some(h => h.startsWith('cnt_'));
  const hasPP = normalized.some(h => h.startsWith('pp_'));
  const hasST = normalized.some(h => h.startsWith('st_'));
  const hasSUB = normalized.some(h => h.startsWith('sub_'));
  const hasUSR = normalized.some(h => h.startsWith('usr_'));
  const hasAutoMaster = normalized.some(h => h.startsWith('auto_'));
  
  const prefixCount = [hasCNT, hasPP, hasST, hasSUB, hasUSR].filter(Boolean).length;
  if (prefixCount >= 2 || hasAutoMaster) {
    return 'master';
  }
  
  if (normalized.some(h => h.includes('contact id') || h === 'ghl_contact_id')) {
    return 'ghl';
  }
  
  if (normalized.includes('id') && normalized.includes('amount') && 
      (normalized.includes('payment_intent') || normalized.includes('customer') || normalized.includes('status'))) {
    return 'stripe_payments';
  }
  
  if (normalized.some(h => h.includes('customer_id') || h === 'customer') && 
      normalized.includes('email') && !normalized.includes('amount')) {
    return 'stripe_customers';
  }
  
  if (normalized.some(h => h === 'nombre' || h === 'transaction id' || h.includes('correo electrónico'))) {
    return 'paypal';
  }
  
  if (normalized.some(h => h.includes('subscription')) && normalized.some(h => h.includes('plan'))) {
    return 'subscriptions';
  }
  
  return 'auto';
}

// ============= PHASE 1: FAST INSERT (MINIMAL PROCESSING) =============
// Stores raw CSV data with minimal validation - optimized for speed
async function stageCSVDataFast(
  lines: string[],
  headers: string[],
  sourceType: string,
  importId: string,
  supabase: AnySupabaseClient
): Promise<{ staged: number; errors: number }> {
  // Find email/phone columns for quick lookups later
  const emailIdx = findColumnIndex(headers, ['email', 'correo electronico', 'correo', 'customer_email', 'auto_master_email']);
  const phoneIdx = findColumnIndex(headers, ['phone', 'telefono', 'tel', 'auto_phone']);
  const nameIdx = findColumnIndex(headers, [
    'auto_master_name', 'full_name', 'name', 'nombre',
    'cnt_first name', 'cnt_firstname'
  ]);

  // Prepare staging records - use simpler objects
  const stagingRows: {
    import_id: string;
    row_number: number;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    source_type: string;
    raw_data: Record<string, string>;
    processing_status: string;
  }[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      
      // Build raw_data object with all columns (simplified)
      const rawData: Record<string, string> = {};
      for (let j = 0; j < headers.length && j < values.length; j++) {
        const val = values[j]?.replace(/"/g, '').trim();
        if (val) rawData[headers[j]] = val;
      }

      // Extract email/phone for indexing
      let email = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim().toLowerCase() : null;
      if (email && !email.includes('@')) email = null;
      
      const phone = phoneIdx >= 0 ? normalizePhone(values[phoneIdx] || '') : null;
      const fullName = nameIdx >= 0 ? values[nameIdx]?.replace(/"/g, '').trim() || null : null;

      stagingRows.push({
        import_id: importId,
        row_number: i,
        email,
        phone,
        full_name: fullName,
        source_type: sourceType,
        raw_data: rawData,
        processing_status: 'pending'
      });
    } catch (_err) {
      // Skip failed rows silently for speed
    }
  }

  // Batch insert into staging table - larger batches for speed
  const BATCH_SIZE = 500;
  let stagedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < stagingRows.length; i += BATCH_SIZE) {
    const batch = stagingRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('csv_imports_raw').insert(batch);
    
    if (error) {
      logger.error(`Staging batch failed`, error);
      errorCount += batch.length;
    } else {
      stagedCount += batch.length;
    }
  }

  return { staged: stagedCount, errors: errorCount };
}

// ============= PHASE 2: MERGE (BACKGROUND) =============
// Processes staged data and merges into clients/transactions
async function processMergeInBackground(
  importId: string,
  sourceType: string,
  supabase: AnySupabaseClient
): Promise<void> {
  logger.info('Starting background merge', { importId, sourceType });
  
  try {
    // Update status to processing
    await supabase.from('csv_import_runs').update({
      status: 'processing'
    }).eq('id', importId);

    // Fetch all pending rows for this import
    const { data: pendingRows, error: fetchError } = await supabase
      .from('csv_imports_raw')
      .select('*')
      .eq('import_id', importId)
      .eq('processing_status', 'pending')
      .order('row_number', { ascending: true });

    if (fetchError) {
      throw new Error(`Failed to fetch staged rows: ${fetchError.message}`);
    }

    if (!pendingRows || pendingRows.length === 0) {
      logger.info('No pending rows to merge', { importId });
      await supabase.from('csv_import_runs').update({
        status: 'completed',
        completed_at: new Date().toISOString()
      }).eq('id', importId);
      return;
    }

    let mergedCount = 0;
    let conflictCount = 0;
    let errorCount = 0;
    const BATCH_SIZE = 500;

    // Group by email for batch processing
    const emailGroups = new Map<string, typeof pendingRows>();
    for (const row of pendingRows) {
      if (row.email) {
        const existing = emailGroups.get(row.email) || [];
        existing.push(row);
        emailGroups.set(row.email, existing);
      } else if (row.phone) {
        // Group by phone if no email
        const key = `phone:${row.phone}`;
        const existing = emailGroups.get(key) || [];
        existing.push(row);
        emailGroups.set(key, existing);
      } else {
        // Skip rows without email or phone
        await supabase.from('csv_imports_raw').update({
          processing_status: 'skipped',
          error_message: 'No email or phone',
          processed_at: new Date().toISOString()
        }).eq('id', row.id);
        errorCount++;
      }
    }

    // Process each email group
    const emails = [...emailGroups.keys()].filter(k => !k.startsWith('phone:'));
    
    // Batch lookup existing clients
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batchEmails = emails.slice(i, i + BATCH_SIZE);
      
      const { data: existingClients } = await supabase
        .from('clients')
        .select('id, email, ghl_contact_id, stripe_customer_id')
        .in('email', batchEmails);

      const existingByEmail = new Map(
        (existingClients || []).map(c => [c.email, c])
      );

      // Process this batch
      const clientsToUpsert: Record<string, unknown>[] = [];
      const rowsToUpdate: { id: string; status: string; clientId?: string; error?: string }[] = [];

      for (const email of batchEmails) {
        const rows = emailGroups.get(email) || [];
        if (rows.length === 0) continue;

        // Merge all rows for this email
        const mergedData: Record<string, unknown> = { email };
        let ghlContactId: string | null = null;
        let stripeCustomerId: string | null = null;
        let totalSpend = 0;
        const tags: string[] = [];

        for (const row of rows) {
          const rawData = row.raw_data as Record<string, string>;
          
          // Extract common fields
          if (!mergedData.full_name && row.full_name) {
            mergedData.full_name = row.full_name;
          }
          if (!mergedData.phone && row.phone) {
            mergedData.phone = row.phone;
          }

          // GHL fields
          if (rawData['cnt_contact id'] || rawData['ghl_contact_id']) {
            ghlContactId = rawData['cnt_contact id'] || rawData['ghl_contact_id'];
          }
          
          // Stripe fields
          if (rawData['st_customer id'] || rawData['stripe_customer_id']) {
            stripeCustomerId = rawData['st_customer id'] || rawData['stripe_customer_id'];
          }

          // Accumulate spend
          const spend = normalizeAmount(rawData['auto_total_spend'] || rawData['total_spend'] || '0');
          if (spend > totalSpend) totalSpend = spend;

          // Merge tags
          const rowTags = (rawData['cnt_tags'] || rawData['tags'] || '').split(',').map(t => t.trim()).filter(Boolean);
          tags.push(...rowTags);
        }

        // Build upsert record
        const existing = existingByEmail.get(email);
        
        if (ghlContactId) mergedData.ghl_contact_id = ghlContactId;
        if (stripeCustomerId) mergedData.stripe_customer_id = stripeCustomerId;
        if (totalSpend > 0) mergedData.total_spend = totalSpend;
        if (tags.length > 0) mergedData.tags = [...new Set(tags)];
        
        mergedData.lifecycle_stage = totalSpend > 0 ? 'CUSTOMER' : 'LEAD';
        mergedData.last_sync = new Date().toISOString();

        clientsToUpsert.push(mergedData);

        // Mark rows as processed
        for (const row of rows) {
          rowsToUpdate.push({
            id: row.id,
            status: 'merged',
            clientId: existing?.id
          });
        }
      }

      // Upsert clients
      if (clientsToUpsert.length > 0) {
        const { error: upsertError } = await supabase
          .from('clients')
          .upsert(clientsToUpsert, { onConflict: 'email' });

        if (upsertError) {
          logger.error('Client upsert failed', upsertError);
          for (const row of rowsToUpdate) {
            row.status = 'error';
            row.error = upsertError.message;
            errorCount++;
          }
        } else {
          mergedCount += clientsToUpsert.length;
        }
      }

      // Update staging rows status
      for (const update of rowsToUpdate) {
        await supabase.from('csv_imports_raw').update({
          processing_status: update.status,
          merged_client_id: update.clientId,
          error_message: update.error,
          processed_at: new Date().toISOString()
        }).eq('id', update.id);
      }

      // Log progress
      logger.info('Merge progress', {
        importId,
        processed: i + batchEmails.length,
        total: emails.length,
        merged: mergedCount,
        conflicts: conflictCount,
        errors: errorCount
      });
    }

    // Update import run with final stats
    await supabase.from('csv_import_runs').update({
      rows_merged: mergedCount,
      rows_conflict: conflictCount,
      rows_error: errorCount,
      status: 'completed',
      completed_at: new Date().toISOString()
    }).eq('id', importId);

    logger.info('Background merge complete', {
      importId,
      merged: mergedCount,
      conflicts: conflictCount,
      errors: errorCount
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Background merge failed', error instanceof Error ? error : new Error(errMsg));
    await supabase.from('csv_import_runs').update({
      status: 'failed',
      error_message: errMsg,
      completed_at: new Date().toISOString()
    }).eq('id', importId);
  }
}

// ============= LEGACY DIRECT PROCESSORS =============
// These process directly without staging (for backwards compatibility)

async function processGHL(
  lines: string[],
  headers: string[],
  supabase: AnySupabaseClient
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const result: ProcessingResult = {
    csvType: 'ghl',
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    duration: 0
  };

  const contactIdIdx = headers.findIndex(h => h.includes('contact id') || h === 'id');
  const emailIdx = headers.findIndex(h => h === 'email');
  const phoneIdx = headers.findIndex(h => h === 'phone');
  const firstNameIdx = headers.findIndex(h => h.includes('first name') || h === 'firstname');
  const lastNameIdx = headers.findIndex(h => h.includes('last name') || h === 'lastname');
  const tagsIdx = headers.findIndex(h => h === 'tags' || h === 'tag');
  const createdIdx = headers.findIndex(h => h.includes('created') || h === 'datecreated');

  if (contactIdIdx === -1) {
    result.errors.push('Missing Contact Id column');
    return result;
  }

  interface GHLContact {
    ghlContactId: string;
    email: string | null;
    phone: string | null;
    fullName: string | null;
    tags: string[];
    dateCreated: string | null;
  }

  const contacts: GHLContact[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      const ghlContactId = values[contactIdIdx]?.replace(/"/g, '').trim();
      if (!ghlContactId) continue;

      let email = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim().toLowerCase() : '';
      if (email && !email.includes('@')) email = '';

      const rawPhone = phoneIdx >= 0 ? values[phoneIdx]?.replace(/"/g, '').trim() : '';
      const phone = normalizePhone(rawPhone);

      if (!email && !phone) {
        result.skipped++;
        continue;
      }

      const firstName = firstNameIdx >= 0 ? values[firstNameIdx]?.replace(/"/g, '').trim() : '';
      const lastName = lastNameIdx >= 0 ? values[lastNameIdx]?.replace(/"/g, '').trim() : '';
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;

      const rawTags = tagsIdx >= 0 ? values[tagsIdx]?.replace(/"/g, '').trim() : '';
      const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : [];

      const dateCreated = createdIdx >= 0 ? values[createdIdx]?.replace(/"/g, '').trim() : null;

      contacts.push({ ghlContactId, email: email || null, phone, fullName, tags, dateCreated });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  const BATCH_SIZE = 500;
  const toUpsert: Record<string, unknown>[] = [];

  for (const contact of contacts) {
    if (!contact.email) continue;

    const record: Record<string, unknown> = {
      email: contact.email,
      ghl_contact_id: contact.ghlContactId,
      last_sync: new Date().toISOString()
    };

    if (contact.fullName) record.full_name = contact.fullName;
    if (contact.phone) record.phone = contact.phone;
    if (contact.tags.length > 0) record.tags = contact.tags;
    record.acquisition_source = 'ghl';
    record.lifecycle_stage = 'LEAD';

    if (contact.dateCreated) {
      try {
        record.first_seen_at = new Date(contact.dateCreated).toISOString();
      } catch { /* invalid date */ }
    }

    toUpsert.push(record);
  }

  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (error) {
      result.errors.push(`Upsert batch: ${error.message}`);
    } else {
      result.created += batch.length;
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

async function processStripePayments(
  lines: string[],
  headers: string[],
  supabase: AnySupabaseClient
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const result: ProcessingResult = {
    csvType: 'stripe_payments',
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    duration: 0
  };

  const idIdx = headers.findIndex(h => h === 'id');
  const amountIdx = headers.findIndex(h => h === 'amount');
  const currencyIdx = headers.findIndex(h => h === 'currency');
  const statusIdx = headers.findIndex(h => h === 'status');
  const customerIdx = headers.findIndex(h => h === 'customer' || h === 'customer_id');
  const emailIdx = headers.findIndex(h => h === 'customer_email' || h === 'email');
  const createdIdx = headers.findIndex(h => h === 'created' || h === 'created_at');
  const paymentIntentIdx = headers.findIndex(h => h === 'payment_intent');

  if (idIdx === -1 || amountIdx === -1) {
    result.errors.push('Missing required columns: id, amount');
    return result;
  }

  const BATCH_SIZE = 500;
  const transactions: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      const id = values[idIdx]?.replace(/"/g, '').trim();
      if (!id) continue;

      const rawData: Record<string, string> = {};
      headers.forEach((h, idx) => {
        if (values[idx]) rawData[h] = values[idx].replace(/"/g, '').trim();
      });

      const amount = normalizeAmount(values[amountIdx] || '0');
      const currency = currencyIdx >= 0 ? values[currencyIdx]?.replace(/"/g, '').trim().toLowerCase() || 'usd' : 'usd';
      const status = statusIdx >= 0 ? values[statusIdx]?.replace(/"/g, '').trim() || 'succeeded' : 'succeeded';
      const customerEmail = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim().toLowerCase() || null : null;
      const customerId = customerIdx >= 0 ? values[customerIdx]?.replace(/"/g, '').trim() || null : null;
      const created = createdIdx >= 0 ? values[createdIdx]?.replace(/"/g, '').trim() || null : null;
      const paymentIntent = paymentIntentIdx >= 0 ? values[paymentIntentIdx]?.replace(/"/g, '').trim() || null : null;

      transactions.push({
        stripe_payment_intent_id: paymentIntent || id,
        payment_key: id,
        amount,
        currency,
        status,
        customer_email: customerEmail,
        stripe_customer_id: customerId,
        stripe_created_at: created ? new Date(created).toISOString() : null,
        source: 'stripe',
        raw_data: rawData
      });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { onConflict: 'payment_key' });
    if (error) {
      result.errors.push(`Transaction batch: ${error.message}`);
    } else {
      result.created += batch.length;
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

async function processPayPal(
  lines: string[],
  headers: string[],
  supabase: AnySupabaseClient
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const result: ProcessingResult = {
    csvType: 'paypal',
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    duration: 0
  };

  const nameIdx = headers.findIndex(h => h === 'nombre' || h === 'name');
  const emailIdx = headers.findIndex(h => h.includes('correo') || h === 'email' || h.includes('from email'));
  const amountIdx = headers.findIndex(h => h === 'bruto' || h === 'gross' || h === 'amount');
  const transactionIdx = headers.findIndex(h => h.includes('transaction id') || h === 'id de transacción');
  const dateIdx = headers.findIndex(h => h === 'fecha' || h === 'date');
  const statusIdx = headers.findIndex(h => h === 'estado' || h === 'status');

  const BATCH_SIZE = 500;
  const txRecords: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      const transactionId = transactionIdx >= 0 ? values[transactionIdx]?.replace(/"/g, '').trim() : null;
      if (!transactionId) {
        result.skipped++;
        continue;
      }

      const rawData: Record<string, string> = {};
      headers.forEach((h, idx) => {
        if (values[idx]) rawData[h] = values[idx].replace(/"/g, '').trim();
      });

      const email = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim().toLowerCase() || null : null;
      const amount = normalizeAmount(values[amountIdx] || '0');
      const date = dateIdx >= 0 ? values[dateIdx]?.replace(/"/g, '').trim() || null : null;
      const status = statusIdx >= 0 ? values[statusIdx]?.replace(/"/g, '').trim() || 'completed' : 'completed';

      txRecords.push({
        stripe_payment_intent_id: `paypal_${transactionId}`,
        payment_key: transactionId,
        external_transaction_id: transactionId,
        amount,
        currency: 'usd',
        status: status.toLowerCase() === 'completado' || status.toLowerCase() === 'completed' ? 'succeeded' : status.toLowerCase(),
        customer_email: email,
        stripe_created_at: date ? new Date(date).toISOString() : null,
        source: 'paypal',
        raw_data: rawData
      });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  for (let i = 0; i < txRecords.length; i += BATCH_SIZE) {
    const batch = txRecords.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { onConflict: 'payment_key' });
    if (error) {
      result.errors.push(`PayPal batch: ${error.message}`);
    } else {
      result.created += batch.length;
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

async function processStripeCustomers(
  lines: string[],
  headers: string[],
  supabase: AnySupabaseClient
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const result: ProcessingResult = {
    csvType: 'stripe_customers',
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    duration: 0
  };

  const emailIdx = headers.findIndex(h => h === 'email');
  const customerIdIdx = headers.findIndex(h => h === 'customer' || h === 'customer_id' || h === 'id');
  const nameIdx = headers.findIndex(h => h === 'name' || h === 'customer_name');
  const ltvIdx = headers.findIndex(h => h === 'ltv' || h === 'lifetime_value' || h === 'total_spend');

  if (emailIdx === -1) {
    result.errors.push('Missing email column');
    return result;
  }

  const BATCH_SIZE = 500;
  const clientRecords: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      const email = values[emailIdx]?.replace(/"/g, '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        result.skipped++;
        continue;
      }

      const customerId = customerIdIdx >= 0 ? values[customerIdIdx]?.replace(/"/g, '').trim() || null : null;
      const name = nameIdx >= 0 ? values[nameIdx]?.replace(/"/g, '').trim() || null : null;
      const ltv = ltvIdx >= 0 ? normalizeAmount(values[ltvIdx] || '0') : 0;

      clientRecords.push({
        email,
        stripe_customer_id: customerId,
        full_name: name,
        total_spend: ltv,
        lifecycle_stage: ltv > 0 ? 'CUSTOMER' : 'LEAD',
        payment_status: ltv > 0 ? 'active' : null
      });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  for (let i = 0; i < clientRecords.length; i += BATCH_SIZE) {
    const batch = clientRecords.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (error) {
      result.errors.push(`Customer batch: ${error.message}`);
    } else {
      result.updated += batch.length;
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

// ============= MAIN HANDLER =============
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  logger.info(`[${requestId}] Starting CSV bulk processing`);

  try {
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: authCheck.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json();
    const { csvText, csvType: requestedType, filename, useStaging = true } = body as { 
      csvText: string; 
      csvType?: CSVType; 
      filename?: string;
      useStaging?: boolean;
    };

    if (!csvText || typeof csvText !== 'string') {
      return new Response(
        JSON.stringify({ ok: false, error: 'csvText is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info(`[${requestId}] CSV bulk processing`, { 
      csvLength: csvText.length, 
      requestedType, 
      filename: filename || 'unknown',
      estimatedLines: csvText.split('\n').length,
      useStaging
    });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Clean CSV
    const cleanCsv = csvText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = cleanCsv.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      return new Response(
        JSON.stringify({ ok: false, error: 'CSV must have at least a header and one data row' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().replace(/"/g, '').trim());
    const csvType = requestedType && requestedType !== 'auto' ? requestedType : detectCSVType(headers);
    const rowCount = lines.length - 1;

    logger.info(`[${requestId}] Processing as type`, { csvType, useStaging, rowCount });

    // ============= FAST STAGING FOR ALL LARGE IMPORTS =============
    // Use staging for any import with >500 rows or explicitly requested
    if (useStaging || rowCount > 500) {
      // Create import run record first
      const importId = crypto.randomUUID();
      
      const { error: runError } = await supabase.from('csv_import_runs').insert({
        id: importId,
        filename: filename || 'unknown',
        source_type: csvType,
        total_rows: rowCount,
        status: 'staging',
        started_at: new Date().toISOString()
      });
      
      if (runError) {
        logger.error('Failed to create import run', runError);
        return new Response(
          JSON.stringify({ ok: false, error: `Failed to create import: ${runError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // PHASE 1: Fast staging (sync) - just insert raw data
      const stagingResult = await stageCSVDataFast(lines, headers, csvType, importId, supabase);
      
      // Update import run with staging count
      await supabase.from('csv_import_runs').update({
        rows_staged: stagingResult.staged,
        status: 'staged',
        staged_at: new Date().toISOString()
      }).eq('id', importId);
      
      // PHASE 2: Start merge in background (non-blocking)
      EdgeRuntime.waitUntil(
        processMergeInBackground(importId, csvType, supabase)
      );
      
      const duration = Date.now() - startTime;
      logger.info(`[${requestId}] Staging complete in ${duration}ms`, {
        importId,
        staged: stagingResult.staged,
        errors: stagingResult.errors
      });

      return new Response(
        JSON.stringify({ 
          ok: true, 
          result: {
            importId,
            staged: stagingResult.staged,
            totalRows: rowCount,
            sourceType: csvType,
            phase: 'staged',
            duration,
            message: `${stagingResult.staged} filas importadas.`
          }
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============= LEGACY DIRECT PROCESSING (small files only) =============
    let result: ProcessingResult;

    switch (csvType) {
      case 'ghl':
        result = await processGHL(lines, headers, supabase);
        break;
      case 'stripe_payments':
        result = await processStripePayments(lines, headers, supabase);
        break;
      case 'stripe_customers':
        result = await processStripeCustomers(lines, headers, supabase);
        break;
      case 'paypal':
        result = await processPayPal(lines, headers, supabase);
        break;
      case 'master': {
        // Master CSVs always use staging
        const masterImportId = crypto.randomUUID();
        await supabase.from('csv_import_runs').insert({
          id: masterImportId,
          filename: filename || 'unknown',
          source_type: 'master',
          total_rows: rowCount,
          status: 'staging'
        });
        
        const masterStaging = await stageCSVDataFast(lines, headers, 'master', masterImportId, supabase);
        EdgeRuntime.waitUntil(
          processMergeInBackground(masterImportId, 'master', supabase)
        );
        
        return new Response(
          JSON.stringify({ 
            ok: true, 
            result: {
              importId: masterImportId,
              staged: masterStaging.staged,
              totalRows: rowCount,
              duration: Date.now() - startTime,
              message: `${masterStaging.staged} filas importadas.`
            }
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      default:
        return new Response(
          JSON.stringify({ ok: false, error: `Unknown CSV type. Headers: ${headers.slice(0, 10).join(', ')}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    const duration = Date.now() - startTime;
    logger.info(`[${requestId}] Processing complete`, { ...result, duration_ms: duration });

    return new Response(
      JSON.stringify({ ok: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error(`[${requestId}] Fatal error after ${duration}ms`, error instanceof Error ? error : new Error(String(error)));
    
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: errorMessage
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
