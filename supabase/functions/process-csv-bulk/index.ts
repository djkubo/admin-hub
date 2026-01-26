// Edge Function: process-csv-bulk
// Universal CSV processor for GHL, Stripe Payments, Stripe Customers, PayPal
// Handles 200k+ records server-side without browser timeout limits

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('process-csv-bulk', LogLevel.INFO);

type CSVType = 'ghl' | 'stripe_payments' | 'stripe_customers' | 'paypal' | 'subscriptions' | 'master' | 'auto';

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

interface ProcessingResult {
  csvType: string;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  duration: number;
  // Master CSV specific counts
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
  return isNaN(num) ? 0 : Math.round(num * 100); // Convert to cents
}

function detectCSVType(headers: string[]): CSVType {
  const normalized = headers.map(h => h.toLowerCase().trim());
  const headerStr = normalized.join(',');
  
  // MASTER CSV: Has prefixed columns from multiple sources
  // Prefixes: CNT_ (GHL/Contact), PP_ (PayPal), ST_ (Stripe), SUB_ (Subscriptions), USR_ (Users)
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
  
  // GHL: Has "contact id" or specific GHL fields
  if (normalized.some(h => h.includes('contact id') || h === 'ghl_contact_id')) {
    return 'ghl';
  }
  
  // Stripe Payments: Has payment_intent or id with amount
  if (normalized.includes('id') && normalized.includes('amount') && 
      (normalized.includes('payment_intent') || normalized.includes('customer') || normalized.includes('status'))) {
    return 'stripe_payments';
  }
  
  // Stripe Customers: Has customer_id or stripe_customer_id
  if (normalized.some(h => h.includes('customer_id') || h === 'customer') && 
      normalized.includes('email') && !normalized.includes('amount')) {
    return 'stripe_customers';
  }
  
  // PayPal: Has "Nombre" or Spanish PayPal fields, or "Transaction ID"
  if (normalized.some(h => h === 'nombre' || h === 'transaction id' || h.includes('correo electrónico'))) {
    return 'paypal';
  }
  
  // Subscriptions: Has subscription_id and plan
  if (normalized.some(h => h.includes('subscription')) && normalized.some(h => h.includes('plan'))) {
    return 'subscriptions';
  }
  
  return 'auto';
}

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

  // Find column indices
  const contactIdIdx = headers.findIndex(h => h.includes('contact id') || h === 'id');
  const emailIdx = headers.findIndex(h => h === 'email');
  const phoneIdx = headers.findIndex(h => h === 'phone');
  const firstNameIdx = headers.findIndex(h => h.includes('first name') || h === 'firstname');
  const lastNameIdx = headers.findIndex(h => h.includes('last name') || h === 'lastname');
  const tagsIdx = headers.findIndex(h => h === 'tags' || h === 'tag');
  const sourceIdx = headers.findIndex(h => h === 'source');
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
    source: string | null;
    dateCreated: string | null;
  }

  const contacts: GHLContact[] = [];

  // Parse all rows
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

      const source = sourceIdx >= 0 ? values[sourceIdx]?.replace(/"/g, '').trim() : null;
      const dateCreated = createdIdx >= 0 ? values[createdIdx]?.replace(/"/g, '').trim() : null;

      contacts.push({ ghlContactId, email: email || null, phone, fullName, tags, source, dateCreated });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  logger.info('GHL contacts parsed', { total: contacts.length });

  // Load existing clients
  const emailContacts = contacts.filter(c => c.email);
  const uniqueEmails = [...new Set(emailContacts.map(c => c.email!))];
  const existingByEmail = new Map<string, { tags?: string[]; full_name?: string }>();
  const BATCH_SIZE = 500; // Reduced to avoid timeouts

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const { data } = await supabase.from('clients').select('email, tags, full_name').in('email', batch);
    data?.forEach(c => existingByEmail.set(c.email, c));
  }

  // Prepare upserts
  const toUpsert: Record<string, unknown>[] = [];

  for (const contact of contacts) {
    if (!contact.email) continue;

    const existing = existingByEmail.get(contact.email);
    const record: Record<string, unknown> = {
      email: contact.email,
      ghl_contact_id: contact.ghlContactId,
      last_sync: new Date().toISOString()
    };

    if (!existing?.full_name && contact.fullName) record.full_name = contact.fullName;
    if (contact.phone) record.phone = contact.phone;
    if (contact.tags.length > 0) {
      record.tags = [...new Set([...(existing?.tags || []), ...contact.tags])];
    }
    record.acquisition_source = 'ghl';
    record.lifecycle_stage = 'LEAD';

    if (contact.dateCreated) {
      try {
        record.first_seen_at = new Date(contact.dateCreated).toISOString();
      } catch { /* invalid date */ }
    }

    toUpsert.push(record);
    if (existing) result.updated++;
    else result.created++;
  }

  // Execute upserts with progress logging and delays
  const totalBatches = Math.ceil(toUpsert.length / BATCH_SIZE);
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (error) {
      result.errors.push(`Upsert batch ${batchNum}/${totalBatches}: ${error.message}`);
    } else {
      if (existingByEmail.has(batch[0]?.email as string)) {
        result.updated += batch.length;
      } else {
        result.created += batch.length;
      }
    }
    
    // Log progress every 10 batches
    if (batchNum % 10 === 0 || batchNum === 1) {
      logger.info('GHL upsert progress', { 
        batch: batchNum, 
        total: totalBatches, 
        processed: i + batch.length, 
        totalRecords: toUpsert.length 
      });
    }
    
    // Small delay every 50 batches to avoid overwhelming DB
    if (batchNum % 50 === 0 && i + BATCH_SIZE < toUpsert.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
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

  // Find column indices - support multiple formats
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

  interface Payment {
    id: string;
    amount: number;
    currency: string;
    status: string;
    customerEmail: string | null;
    customerId: string | null;
    created: string | null;
    paymentIntent: string | null;
    rawData: Record<string, string>;
  }

  const payments: Payment[] = [];

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

      payments.push({ id, amount, currency, status, customerEmail, customerId, created, paymentIntent, rawData });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  logger.info('Stripe payments parsed', { total: payments.length });

  // Prepare transaction inserts
  const BATCH_SIZE = 500;
  const transactions: Record<string, unknown>[] = [];

  for (const payment of payments) {
    const paymentKey = payment.id;
    
    transactions.push({
      stripe_payment_intent_id: payment.paymentIntent || payment.id,
      payment_key: paymentKey,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      customer_email: payment.customerEmail,
      stripe_customer_id: payment.customerId,
      stripe_created_at: payment.created ? new Date(payment.created).toISOString() : null,
      source: 'stripe',
      raw_data: payment.rawData
    });
  }

  // Upsert transactions with progress logging
  const totalTxBatches = Math.ceil(transactions.length / BATCH_SIZE);
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    const { error } = await supabase
      .from('transactions')
      .upsert(batch, { onConflict: 'payment_key' });
    
    if (error) {
      result.errors.push(`Transaction batch ${batchNum}/${totalTxBatches}: ${error.message}`);
    } else {
      result.created += batch.length;
    }

    // Log progress every 10 batches
    if (batchNum % 10 === 0 || batchNum === 1) {
      logger.info('Stripe payments upsert progress', { 
        batch: batchNum, 
        total: totalTxBatches, 
        processed: i + batch.length, 
        totalRecords: transactions.length 
      });
    }
    
    // Small delay every 50 batches
    if (batchNum % 50 === 0 && i + BATCH_SIZE < transactions.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Update clients lifecycle_stage to CUSTOMER for those with payments
  const customerEmails = [...new Set(payments.filter(p => p.customerEmail).map(p => p.customerEmail!))];
  
  for (let i = 0; i < customerEmails.length; i += BATCH_SIZE) {
    const batch = customerEmails.slice(i, i + BATCH_SIZE);
    await supabase
      .from('clients')
      .update({ lifecycle_stage: 'CUSTOMER', payment_status: 'active' })
      .in('email', batch);
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

  // PayPal Spanish headers mapping
  const nameIdx = headers.findIndex(h => h === 'nombre' || h === 'name');
  const emailIdx = headers.findIndex(h => h.includes('correo') || h === 'email' || h.includes('from email'));
  const amountIdx = headers.findIndex(h => h === 'bruto' || h === 'gross' || h === 'amount');
  const currencyIdx = headers.findIndex(h => h === 'divisa' || h === 'currency');
  const statusIdx = headers.findIndex(h => h === 'estado' || h === 'status');
  const transactionIdx = headers.findIndex(h => h.includes('transaction id') || h === 'id de transacción');
  const dateIdx = headers.findIndex(h => h === 'fecha' || h === 'date');
  const typeIdx = headers.findIndex(h => h === 'tipo' || h === 'type');

  interface PayPalTx {
    transactionId: string;
    name: string | null;
    email: string | null;
    amount: number;
    currency: string;
    status: string;
    date: string | null;
    type: string | null;
    rawData: Record<string, string>;
  }

  const transactions: PayPalTx[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      
      const rawData: Record<string, string> = {};
      headers.forEach((h, idx) => {
        if (values[idx]) rawData[h] = values[idx].replace(/"/g, '').trim();
      });

      const transactionId = transactionIdx >= 0 ? values[transactionIdx]?.replace(/"/g, '').trim() : null;
      if (!transactionId) {
        result.skipped++;
        continue;
      }

      const name = nameIdx >= 0 ? values[nameIdx]?.replace(/"/g, '').trim() || null : null;
      const email = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim().toLowerCase() || null : null;
      const amount = normalizeAmount(values[amountIdx] || '0');
      const currency = currencyIdx >= 0 ? values[currencyIdx]?.replace(/"/g, '').trim().toLowerCase() || 'usd' : 'usd';
      const status = statusIdx >= 0 ? values[statusIdx]?.replace(/"/g, '').trim() || 'completed' : 'completed';
      const date = dateIdx >= 0 ? values[dateIdx]?.replace(/"/g, '').trim() || null : null;
      const type = typeIdx >= 0 ? values[typeIdx]?.replace(/"/g, '').trim() || null : null;

      // Skip non-payment types
      if (type && (type.toLowerCase().includes('retiro') || type.toLowerCase().includes('withdrawal'))) {
        result.skipped++;
        continue;
      }

      transactions.push({ transactionId, name, email, amount, currency, status, date, type, rawData });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  logger.info('PayPal transactions parsed', { total: transactions.length });

  const BATCH_SIZE = 500;
  const txRecords: Record<string, unknown>[] = [];

  for (const tx of transactions) {
    txRecords.push({
      stripe_payment_intent_id: `paypal_${tx.transactionId}`,
      payment_key: tx.transactionId,
      external_transaction_id: tx.transactionId,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status === 'Completado' || tx.status === 'completed' ? 'succeeded' : tx.status.toLowerCase(),
      customer_email: tx.email,
      stripe_created_at: tx.date ? new Date(tx.date).toISOString() : null,
      source: 'paypal',
      payment_type: tx.type,
      raw_data: tx.rawData
    });
  }

  const totalPayPalBatches = Math.ceil(txRecords.length / BATCH_SIZE);
  for (let i = 0; i < txRecords.length; i += BATCH_SIZE) {
    const batch = txRecords.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    const { error } = await supabase
      .from('transactions')
      .upsert(batch, { onConflict: 'payment_key' });
    
    if (error) {
      result.errors.push(`PayPal batch ${batchNum}/${totalPayPalBatches}: ${error.message}`);
    } else {
      result.created += batch.length;
    }
    
    // Log progress every 10 batches
    if (batchNum % 10 === 0 || batchNum === 1) {
      logger.info('PayPal upsert progress', { 
        batch: batchNum, 
        total: totalPayPalBatches, 
        processed: i + batch.length, 
        totalRecords: txRecords.length 
      });
    }
    
    // Small delay every 50 batches
    if (batchNum % 50 === 0 && i + BATCH_SIZE < txRecords.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Create/update clients for PayPal customers
  const customerEmails = [...new Set(transactions.filter(t => t.email).map(t => t.email!))];
  const existingEmails = new Set<string>();

  for (let i = 0; i < customerEmails.length; i += BATCH_SIZE) {
    const batch = customerEmails.slice(i, i + BATCH_SIZE);
    const { data } = await supabase.from('clients').select('email').in('email', batch);
    data?.forEach(c => existingEmails.add(c.email));
  }

  const newClients: Record<string, unknown>[] = [];
  for (const tx of transactions) {
    if (tx.email && !existingEmails.has(tx.email)) {
      newClients.push({
        email: tx.email,
        full_name: tx.name,
        lifecycle_stage: 'CUSTOMER',
        acquisition_source: 'paypal',
        payment_status: 'active'
      });
      existingEmails.add(tx.email);
    }
  }

  for (let i = 0; i < newClients.length; i += BATCH_SIZE) {
    const batch = newClients.slice(i, i + BATCH_SIZE);
    await supabase.from('clients').upsert(batch, { onConflict: 'email' });
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

  interface Customer {
    email: string;
    customerId: string | null;
    name: string | null;
    ltv: number;
  }

  const customers: Customer[] = [];

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

      customers.push({ email, customerId, name, ltv });
      result.totalRows++;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  logger.info('Stripe customers parsed', { total: customers.length });

  const BATCH_SIZE = 500;
  const clientRecords: Record<string, unknown>[] = [];

  for (const customer of customers) {
    clientRecords.push({
      email: customer.email,
      stripe_customer_id: customer.customerId,
      full_name: customer.name,
      total_spend: customer.ltv,
      lifecycle_stage: customer.ltv > 0 ? 'CUSTOMER' : 'LEAD',
      payment_status: customer.ltv > 0 ? 'active' : null
    });
  }

  const totalCustomerBatches = Math.ceil(clientRecords.length / BATCH_SIZE);
  for (let i = 0; i < clientRecords.length; i += BATCH_SIZE) {
    const batch = clientRecords.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    
    if (error) {
      result.errors.push(`Customer batch ${batchNum}/${totalCustomerBatches}: ${error.message}`);
    } else {
      result.updated += batch.length; // These are updates, not new clients
    }
    
    // Log progress every 10 batches
    if (batchNum % 10 === 0 || batchNum === 1) {
      logger.info('Stripe customers upsert progress', { 
        batch: batchNum, 
        total: totalCustomerBatches, 
        processed: i + batch.length, 
        totalRecords: clientRecords.length 
      });
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

// ============= MASTER CSV PROCESSOR =============
// Processes CSV with prefixed columns: CNT_ (GHL), PP_ (PayPal), ST_ (Stripe), SUB_ (Subscriptions), USR_ (Users)
async function processMasterCSV(
  lines: string[],
  headers: string[],
  supabase: AnySupabaseClient
): Promise<ProcessingResult> {
  const startTime = Date.now();
  const result: ProcessingResult = {
    csvType: 'master',
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    duration: 0,
    ghlContacts: 0,
    stripePayments: 0,
    paypalPayments: 0,
    subscriptions: 0,
    transactionsCreated: 0,
    clientsCreated: 0,
    clientsUpdated: 0
  };

  // Build column index maps by prefix
  const colMap: Record<string, number> = {};
  headers.forEach((h, idx) => {
    colMap[h] = idx;
  });

  // Find key columns
  const emailIdx = headers.findIndex(h => h === 'email');
  
  // Auto_Master fields (pre-calculated unified data)
  const autoNameIdx = colMap['auto_master_name'] ?? -1;
  const autoPhoneIdx = colMap['auto_master_phone'] ?? -1;
  const autoSpendIdx = colMap['auto_total_spend'] ?? -1;
  const autoSourcesIdx = colMap['auto_data_sources'] ?? -1;
  
  // CNT_ (GHL Contact) fields
  const cntContactIdIdx = colMap['cnt_contact id'] ?? -1;
  const cntFirstNameIdx = colMap['cnt_first name'] ?? -1;
  const cntLastNameIdx = colMap['cnt_last name'] ?? -1;
  const cntPhoneIdx = colMap['cnt_phone'] ?? -1;
  const cntTagsIdx = colMap['cnt_tags'] ?? -1;
  const cntCreatedIdx = colMap['cnt_created'] ?? -1;
  
  // ST_ (Stripe) fields
  const stIdIdx = colMap['st_id'] ?? -1;
  const stAmountIdx = colMap['st_amount'] ?? -1;
  const stStatusIdx = colMap['st_status'] ?? -1;
  const stCurrencyIdx = colMap['st_currency'] ?? -1;
  const stCreatedIdx = colMap['st_created date (utc)'] ?? -1;
  const stCustomerIdIdx = colMap['st_customer id'] ?? -1;
  const stPaymentIntentIdx = colMap['st_paymentintent id'] ?? -1;
  
  // PP_ (PayPal) fields
  const ppTxIdIdx = colMap['pp_id. de transacción'] ?? colMap['pp_id de transacción'] ?? -1;
  const ppBrutoIdx = colMap['pp_bruto'] ?? -1;
  const ppEstadoIdx = colMap['pp_estado'] ?? -1;
  const ppFechaIdx = colMap['pp_fecha'] ?? -1;
  const ppNombreIdx = colMap['pp_nombre'] ?? -1;
  
  // SUB_ (Subscription) fields
  const subPlanNameIdx = colMap['sub_plan name'] ?? -1;
  const subStatusIdx = colMap['sub_status'] ?? -1;
  const subPriceIdx = colMap['sub_price'] ?? -1;
  const subExpiresIdx = colMap['sub_expires at (cdmx)'] ?? -1;
  const subCreatedIdx = colMap['sub_created at (cdmx)'] ?? -1;
  
  // USR_ (User) fields
  const usrNombreIdx = colMap['usr_nombre'] ?? -1;
  const usrTelefonoIdx = colMap['usr_telefono'] ?? -1;
  const usrRoleIdx = colMap['usr_role'] ?? -1;

  if (emailIdx === -1) {
    result.errors.push('Missing Email column in Master CSV');
    return result;
  }

  logger.info('Master CSV column mapping', { 
    emailIdx, autoNameIdx, autoPhoneIdx, cntContactIdIdx, stIdIdx, ppTxIdIdx, subPlanNameIdx,
    totalColumns: headers.length
  });

  interface MasterRow {
    email: string;
    // Unified fields
    fullName: string | null;
    phone: string | null;
    totalSpend: number;
    dataSources: string[];
    // GHL fields
    ghlContactId: string | null;
    ghlTags: string[];
    ghlCreated: string | null;
    // Stripe transaction
    stripeId: string | null;
    stripeAmount: number;
    stripeStatus: string | null;
    stripeCurrency: string | null;
    stripeCreated: string | null;
    stripeCustomerId: string | null;
    stripePaymentIntent: string | null;
    // PayPal transaction
    paypalTxId: string | null;
    paypalAmount: number;
    paypalStatus: string | null;
    paypalDate: string | null;
    // Subscription
    subPlanName: string | null;
    subStatus: string | null;
    subPrice: number;
    subExpires: string | null;
    subCreated: string | null;
    // User
    userRole: string | null;
  }

  const rows: MasterRow[] = [];

  // Parse all rows
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

      // Parse unified fields
      const autoName = autoNameIdx >= 0 ? values[autoNameIdx]?.replace(/"/g, '').trim() || null : null;
      const autoPhone = autoPhoneIdx >= 0 ? normalizePhone(values[autoPhoneIdx] || '') : null;
      const autoSpend = autoSpendIdx >= 0 ? normalizeAmount(values[autoSpendIdx] || '0') : 0;
      const autoSources = autoSourcesIdx >= 0 ? (values[autoSourcesIdx]?.replace(/"/g, '').trim() || '').split(',').filter(Boolean) : [];

      // Parse GHL fields
      const cntContactId = cntContactIdIdx >= 0 ? values[cntContactIdIdx]?.replace(/"/g, '').trim() || null : null;
      const cntFirstName = cntFirstNameIdx >= 0 ? values[cntFirstNameIdx]?.replace(/"/g, '').trim() || '' : '';
      const cntLastName = cntLastNameIdx >= 0 ? values[cntLastNameIdx]?.replace(/"/g, '').trim() || '' : '';
      const cntFullName = [cntFirstName, cntLastName].filter(Boolean).join(' ') || null;
      const cntPhone = cntPhoneIdx >= 0 ? normalizePhone(values[cntPhoneIdx] || '') : null;
      const cntTags = cntTagsIdx >= 0 ? (values[cntTagsIdx]?.replace(/"/g, '').trim() || '').split(',').map(t => t.trim()).filter(Boolean) : [];
      const cntCreated = cntCreatedIdx >= 0 ? values[cntCreatedIdx]?.replace(/"/g, '').trim() || null : null;

      // Parse Stripe fields
      const stId = stIdIdx >= 0 ? values[stIdIdx]?.replace(/"/g, '').trim() || null : null;
      const stAmount = stAmountIdx >= 0 ? normalizeAmount(values[stAmountIdx] || '0') : 0;
      const stStatus = stStatusIdx >= 0 ? values[stStatusIdx]?.replace(/"/g, '').trim() || null : null;
      const stCurrency = stCurrencyIdx >= 0 ? values[stCurrencyIdx]?.replace(/"/g, '').trim().toLowerCase() || 'usd' : 'usd';
      const stCreated = stCreatedIdx >= 0 ? values[stCreatedIdx]?.replace(/"/g, '').trim() || null : null;
      const stCustomerId = stCustomerIdIdx >= 0 ? values[stCustomerIdIdx]?.replace(/"/g, '').trim() || null : null;
      const stPaymentIntent = stPaymentIntentIdx >= 0 ? values[stPaymentIntentIdx]?.replace(/"/g, '').trim() || null : null;

      // Parse PayPal fields
      const ppTxId = ppTxIdIdx >= 0 ? values[ppTxIdIdx]?.replace(/"/g, '').trim() || null : null;
      const ppAmount = ppBrutoIdx >= 0 ? normalizeAmount(values[ppBrutoIdx] || '0') : 0;
      const ppStatus = ppEstadoIdx >= 0 ? values[ppEstadoIdx]?.replace(/"/g, '').trim() || null : null;
      const ppDate = ppFechaIdx >= 0 ? values[ppFechaIdx]?.replace(/"/g, '').trim() || null : null;

      // Parse Subscription fields
      const subPlanName = subPlanNameIdx >= 0 ? values[subPlanNameIdx]?.replace(/"/g, '').trim() || null : null;
      const subStatus = subStatusIdx >= 0 ? values[subStatusIdx]?.replace(/"/g, '').trim() || null : null;
      const subPrice = subPriceIdx >= 0 ? normalizeAmount(values[subPriceIdx] || '0') : 0;
      const subExpires = subExpiresIdx >= 0 ? values[subExpiresIdx]?.replace(/"/g, '').trim() || null : null;
      const subCreated = subCreatedIdx >= 0 ? values[subCreatedIdx]?.replace(/"/g, '').trim() || null : null;

      // Parse User fields
      const usrNombre = usrNombreIdx >= 0 ? values[usrNombreIdx]?.replace(/"/g, '').trim() || null : null;
      const usrPhone = usrTelefonoIdx >= 0 ? normalizePhone(values[usrTelefonoIdx] || '') : null;
      const usrRole = usrRoleIdx >= 0 ? values[usrRoleIdx]?.replace(/"/g, '').trim() || null : null;

      // Determine best name and phone (priority: Auto > GHL > USR > PayPal)
      const bestName = autoName || cntFullName || usrNombre || (ppNombreIdx >= 0 ? values[ppNombreIdx]?.replace(/"/g, '').trim() : null);
      const bestPhone = autoPhone || cntPhone || usrPhone;

      rows.push({
        email,
        fullName: bestName,
        phone: bestPhone,
        totalSpend: autoSpend,
        dataSources: autoSources,
        ghlContactId: cntContactId,
        ghlTags: cntTags,
        ghlCreated: cntCreated,
        stripeId: stId,
        stripeAmount: stAmount,
        stripeStatus: stStatus,
        stripeCurrency: stCurrency,
        stripeCreated: stCreated,
        stripeCustomerId: stCustomerId,
        stripePaymentIntent: stPaymentIntent,
        paypalTxId: ppTxId,
        paypalAmount: ppAmount,
        paypalStatus: ppStatus,
        paypalDate: ppDate,
        subPlanName: subPlanName,
        subStatus: subStatus,
        subPrice: subPrice,
        subExpires: subExpires,
        subCreated: subCreated,
        userRole: usrRole
      });

      result.totalRows++;
      if (cntContactId) result.ghlContacts = (result.ghlContacts || 0) + 1;
      if (stId) result.stripePayments = (result.stripePayments || 0) + 1;
      if (ppTxId) result.paypalPayments = (result.paypalPayments || 0) + 1;
      if (subPlanName) result.subscriptions = (result.subscriptions || 0) + 1;

    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Parse error'}`);
    }
  }

  logger.info('Master CSV parsed', { 
    total: rows.length, 
    ghl: result.ghlContacts, 
    stripe: result.stripePayments, 
    paypal: result.paypalPayments,
    subs: result.subscriptions
  });

  const BATCH_SIZE = 500;

  // 1. UPSERT CLIENTS
  const uniqueEmails = [...new Set(rows.map(r => r.email))];
  const existingEmails = new Set<string>();
  
  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const { data } = await supabase.from('clients').select('email').in('email', batch);
    data?.forEach(c => existingEmails.add(c.email));
  }

  // Group rows by email to aggregate data
  const emailMap = new Map<string, MasterRow[]>();
  for (const row of rows) {
    const existing = emailMap.get(row.email) || [];
    existing.push(row);
    emailMap.set(row.email, existing);
  }

  const clientRecords: Record<string, unknown>[] = [];
  
  for (const [email, emailRows] of emailMap) {
    // Aggregate data from all rows for this email
    const firstRow = emailRows[0];
    let totalSpend = 0;
    let hasPayment = false;
    const allTags: string[] = [];
    
    for (const row of emailRows) {
      if (row.stripeAmount > 0 && row.stripeStatus?.toLowerCase() === 'succeeded') {
        totalSpend += row.stripeAmount;
        hasPayment = true;
      }
      if (row.paypalAmount > 0 && (row.paypalStatus?.toLowerCase() === 'completado' || row.paypalStatus?.toLowerCase() === 'completed')) {
        totalSpend += row.paypalAmount;
        hasPayment = true;
      }
      allTags.push(...row.ghlTags);
    }

    // Determine lifecycle stage
    let lifecycleStage = 'LEAD';
    if (hasPayment || totalSpend > 0) {
      lifecycleStage = 'CUSTOMER';
    } else if (firstRow.subStatus?.toLowerCase() === 'trial' || firstRow.subPlanName?.toLowerCase().includes('trial')) {
      lifecycleStage = 'TRIAL';
    }

    clientRecords.push({
      email,
      full_name: firstRow.fullName,
      phone: firstRow.phone,
      phone_e164: firstRow.phone,
      total_spend: totalSpend > 0 ? totalSpend : (firstRow.totalSpend || 0),
      ghl_contact_id: firstRow.ghlContactId,
      stripe_customer_id: firstRow.stripeCustomerId,
      tags: [...new Set(allTags)],
      lifecycle_stage: lifecycleStage,
      payment_status: hasPayment ? 'active' : null,
      acquisition_source: firstRow.dataSources[0] || 'master_import',
      last_sync: new Date().toISOString()
    });

    if (existingEmails.has(email)) {
      result.clientsUpdated = (result.clientsUpdated || 0) + 1;
    } else {
      result.clientsCreated = (result.clientsCreated || 0) + 1;
    }
  }

  // Upsert clients
  const totalClientBatches = Math.ceil(clientRecords.length / BATCH_SIZE);
  for (let i = 0; i < clientRecords.length; i += BATCH_SIZE) {
    const batch = clientRecords.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (error) {
      result.errors.push(`Client batch ${batchNum}/${totalClientBatches}: ${error.message}`);
    }
    
    if (batchNum % 10 === 0 || batchNum === 1) {
      logger.info('Master CSV client upsert progress', { batch: batchNum, total: totalClientBatches });
    }
  }

  result.updated = result.clientsUpdated || 0;
  result.created = result.clientsCreated || 0;

  // 2. INSERT STRIPE TRANSACTIONS
  const stripeTransactions: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.stripeId && row.stripeAmount > 0) {
      stripeTransactions.push({
        stripe_payment_intent_id: row.stripePaymentIntent || row.stripeId,
        payment_key: row.stripeId,
        amount: row.stripeAmount,
        currency: row.stripeCurrency || 'usd',
        status: row.stripeStatus?.toLowerCase() === 'succeeded' ? 'succeeded' : row.stripeStatus?.toLowerCase() || 'pending',
        customer_email: row.email,
        stripe_customer_id: row.stripeCustomerId,
        stripe_created_at: row.stripeCreated ? new Date(row.stripeCreated).toISOString() : null,
        source: 'stripe'
      });
    }
  }

  for (let i = 0; i < stripeTransactions.length; i += BATCH_SIZE) {
    const batch = stripeTransactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { onConflict: 'payment_key' });
    if (error) {
      result.errors.push(`Stripe tx batch: ${error.message}`);
    } else {
      result.transactionsCreated = (result.transactionsCreated || 0) + batch.length;
    }
  }

  // 3. INSERT PAYPAL TRANSACTIONS
  const paypalTransactions: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.paypalTxId && row.paypalAmount !== 0) {
      paypalTransactions.push({
        stripe_payment_intent_id: `paypal_${row.paypalTxId}`,
        payment_key: row.paypalTxId,
        external_transaction_id: row.paypalTxId,
        amount: row.paypalAmount,
        currency: 'usd', // PayPal amounts will be in original currency
        status: row.paypalStatus?.toLowerCase() === 'completado' || row.paypalStatus?.toLowerCase() === 'completed' ? 'succeeded' : 'pending',
        customer_email: row.email,
        stripe_created_at: row.paypalDate ? new Date(row.paypalDate).toISOString() : null,
        source: 'paypal'
      });
    }
  }

  for (let i = 0; i < paypalTransactions.length; i += BATCH_SIZE) {
    const batch = paypalTransactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { onConflict: 'payment_key' });
    if (error) {
      result.errors.push(`PayPal tx batch: ${error.message}`);
    } else {
      result.transactionsCreated = (result.transactionsCreated || 0) + batch.length;
    }
  }

  // 4. INSERT SUBSCRIPTIONS (if subscription table exists)
  const subscriptionRecords: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.subPlanName) {
      subscriptionRecords.push({
        stripe_subscription_id: `master_${row.email}_${row.subPlanName}`.replace(/[^a-zA-Z0-9_]/g, '_'),
        customer_email: row.email,
        plan_name: row.subPlanName,
        status: row.subStatus?.toLowerCase() || 'active',
        amount: row.subPrice,
        current_period_end: row.subExpires ? new Date(row.subExpires).toISOString() : null,
        created_at: row.subCreated ? new Date(row.subCreated).toISOString() : new Date().toISOString(),
        provider: 'master_import'
      });
    }
  }

  for (let i = 0; i < subscriptionRecords.length; i += BATCH_SIZE) {
    const batch = subscriptionRecords.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('subscriptions').upsert(batch, { onConflict: 'stripe_subscription_id' });
    if (error) {
      result.errors.push(`Subscription batch: ${error.message}`);
    }
  }

  result.duration = Date.now() - startTime;
  
  logger.info('Master CSV processing complete', {
    totalRows: result.totalRows,
    clientsCreated: result.clientsCreated,
    clientsUpdated: result.clientsUpdated,
    transactionsCreated: result.transactionsCreated,
    ghlContacts: result.ghlContacts,
    stripePayments: result.stripePayments,
    paypalPayments: result.paypalPayments,
    subscriptions: result.subscriptions,
    duration: result.duration
  });

  return result;
}

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

    const { csvText, csvType: requestedType, filename } = await req.json() as { csvText: string; csvType?: CSVType; filename?: string };

    if (!csvText || typeof csvText !== 'string') {
      return new Response(
        JSON.stringify({ ok: false, error: 'csvText is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info(`[${requestId}] Starting CSV bulk processing`, { 
      csvLength: csvText.length, 
      requestedType, 
      filename: filename || 'unknown',
      estimatedLines: csvText.split('\n').length 
    });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Remove BOM and normalize line endings
    const cleanCsv = csvText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = cleanCsv.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      return new Response(
        JSON.stringify({ ok: false, error: 'CSV must have at least a header and one data row' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse headers
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().replace(/"/g, '').trim());

    logger.info('CSV headers parsed', { headerCount: headers.length, sampleHeaders: headers.slice(0, 10) });

    // Detect or use requested type
    const csvType = requestedType && requestedType !== 'auto' ? requestedType : detectCSVType(headers);

    logger.info('Processing as type', { csvType });

    let result: ProcessingResult;

    switch (csvType) {
      case 'master':
        result = await processMasterCSV(lines, headers, supabase);
        break;
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
      default:
        return new Response(
          JSON.stringify({ ok: false, error: `Unknown CSV type. Detected headers: ${headers.slice(0, 10).join(', ')}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    const duration = Date.now() - startTime;
    logger.info(`[${requestId}] Processing complete`, { 
      ...result, 
      duration_ms: duration,
      duration_seconds: Math.round(duration / 1000)
    });

    return new Response(
      JSON.stringify({ ok: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('connection') || duration > 50000;
    
    logger.error(`[${requestId}] Fatal error after ${duration}ms`, error instanceof Error ? error : new Error(String(error)));
    
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: isTimeout 
          ? `Procesamiento interrumpido después de ${Math.round(duration/1000)}s. El archivo es muy grande. Intenta dividirlo en partes más pequeñas o procesa archivos menores a 50MB.`
          : errorMessage
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
