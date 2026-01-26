// Edge Function para procesar CSVs masivos de cualquier tipo
// Soporta: GHL, Stripe Payments, Stripe Customers, PayPal, Subscriptions, Web Users

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const logger = createLogger('process-csv-bulk', LogLevel.INFO);

interface ProcessingResult {
  ok: boolean;
  result?: {
    type: string;
    clientsCreated: number;
    clientsUpdated: number;
    transactionsCreated?: number;
    subscriptionsCreated?: number;
    errors: string[];
  };
  error?: string;
}

// Normalize phone to E.164
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 10) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

// Normalize email
function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.toLowerCase().trim();
  return normalized.includes('@') ? normalized : null;
}

// Parse CSV line (handles quoted fields)
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

// Process GHL CSV
async function processGHL(supabase: any, csvText: string): Promise<ProcessingResult['result']> {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    return { type: 'ghl', clientsCreated: 0, clientsUpdated: 0, errors: ['CSV vacío'] };
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const contactIdIdx = headers.findIndex(h => h.includes('contact id') || h === 'id');
  const emailIdx = headers.findIndex(h => h === 'email');
  const phoneIdx = headers.findIndex(h => h === 'phone');
  const firstNameIdx = headers.findIndex(h => h.includes('first name') || h === 'firstname');
  const lastNameIdx = headers.findIndex(h => h.includes('last name') || h === 'lastname');
  const tagsIdx = headers.findIndex(h => h === 'tags' || h === 'tag');

  if (contactIdIdx === -1) {
    return { type: 'ghl', clientsCreated: 0, clientsUpdated: 0, errors: ['No se encontró columna Contact Id'] };
  }

  const contacts: any[] = [];
  const BATCH_SIZE = 1000;

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseCSVLine(lines[i]);
      const ghlContactId = values[contactIdIdx]?.replace(/"/g, '').trim() || '';
      if (!ghlContactId) continue;

      const email = normalizeEmail(emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim() : '');
      const phone = normalizePhone(phoneIdx >= 0 ? values[phoneIdx]?.replace(/"/g, '').trim() : '');
      if (!email && !phone) continue;

      const firstName = firstNameIdx >= 0 ? values[firstNameIdx]?.replace(/"/g, '').trim() : '';
      const lastName = lastNameIdx >= 0 ? values[lastNameIdx]?.replace(/"/g, '').trim() : '';
      const fullName = firstName || lastName ? `${firstName} ${lastName}`.trim() : '';
      const rawTags = tagsIdx >= 0 ? values[tagsIdx]?.replace(/"/g, '').trim() : '';
      const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(t => t) : [];

      contacts.push({
        ghl_contact_id: ghlContactId,
        email,
        phone,
        full_name: fullName || null,
        tags: tags.length > 0 ? tags : null,
        acquisition_source: 'ghl',
        lifecycle_stage: 'LEAD',
        last_sync: new Date().toISOString()
      });

      if (i % 10000 === 0) {
        logger.info(`Parseados: ${i}/${lines.length - 1} líneas`);
      }
    } catch (error) {
      logger.error(`Error en línea ${i + 1}`, error);
    }
  }

  logger.info(`${contacts.length} contactos parseados`);

  // Load existing by email
  const emailContacts = contacts.filter(c => c.email);
  const uniqueEmails = [...new Set(emailContacts.map(c => c.email))];
  const existingByEmail = new Map();

  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const { data } = await supabase.from('clients').select('email').in('email', batch);
    data?.forEach((c: any) => existingByEmail.set(c.email, c));
  }

  // Prepare upserts
  const toUpsert: any[] = [];
  let created = 0;
  let updated = 0;

  for (const contact of emailContacts) {
    if (existingByEmail.has(contact.email)) {
      updated++;
    } else {
      created++;
    }
    toUpsert.push(contact);
  }

  // Process phone-only
  const phoneOnlyContacts = contacts.filter(c => !c.email && c.phone);
  const uniquePhones = [...new Set(phoneOnlyContacts.map(c => c.phone))];
  const existingByPhone = new Map();

  for (let i = 0; i < uniquePhones.length; i += BATCH_SIZE) {
    const batch = uniquePhones.slice(i, i + BATCH_SIZE);
    const { data } = await supabase.from('clients').select('id,email,phone').in('phone', batch);
    data?.forEach((c: any) => {
      if (c.phone) existingByPhone.set(c.phone, c);
    });
  }

  for (const contact of phoneOnlyContacts) {
    const existing = existingByPhone.get(contact.phone);
    if (existing) {
      updated++;
      toUpsert.push({ ...contact, email: existing.email || undefined });
    } else {
      created++;
      toUpsert.push(contact);
    }
  }

  // Execute upserts
  logger.info(`Insertando/Actualizando ${toUpsert.length} contactos...`);
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (error) {
      logger.error(`Error en batch ${Math.floor(i / BATCH_SIZE) + 1}`, error);
    }
  }

  return { type: 'ghl', clientsCreated: created, clientsUpdated: updated, errors: [] };
}

// Process Stripe Payments CSV
async function processStripePayments(supabase: any, csvText: string): Promise<ProcessingResult['result']> {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    return { type: 'stripe_payments', clientsCreated: 0, clientsUpdated: 0, transactionsCreated: 0, errors: ['CSV vacío'] };
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const idIdx = headers.findIndex(h => h === 'id');
  const emailIdx = headers.findIndex(h => h.includes('customer email') || h === 'email');
  const amountIdx = headers.findIndex(h => h === 'amount');
  const statusIdx = headers.findIndex(h => h === 'status');
  const currencyIdx = headers.findIndex(h => h === 'currency');
  const createdAtIdx = headers.findIndex(h => h.includes('created'));

  const transactions: any[] = [];
  const clients = new Map();
  const BATCH_SIZE = 1000;

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseCSVLine(lines[i]);
      const id = values[idIdx]?.replace(/"/g, '').trim() || '';
      if (!id) continue;

      const email = normalizeEmail(emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim() : '');
      const amountStr = amountIdx >= 0 ? values[amountIdx]?.replace(/"/g, '').trim() : '0';
      const amount = Math.round(parseFloat(amountStr) * 100);
      const status = (statusIdx >= 0 ? values[statusIdx]?.replace(/"/g, '').trim() : '').toLowerCase();
      const currency = (currencyIdx >= 0 ? values[currencyIdx]?.replace(/"/g, '').trim() : 'usd').toLowerCase();
      const createdAt = createdAtIdx >= 0 ? values[createdAtIdx]?.replace(/"/g, '').trim() : '';

      if (!email || amount <= 0) continue;

      transactions.push({
        customer_email: email,
        amount,
        status: status === 'paid' || status === 'succeeded' ? 'paid' : status,
        source: 'stripe',
        payment_key: id,
        external_transaction_id: id,
        stripe_payment_intent_id: id,
        currency,
        created_at: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString()
      });

      if (!clients.has(email)) {
        clients.set(email, {
          email,
          stripe_customer_id: id,
          lifecycle_stage: status === 'paid' || status === 'succeeded' ? 'CUSTOMER' : 'LEAD',
          last_sync: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error(`Error en línea ${i + 1}`, error);
    }
  }

  // Upsert clients
  const clientsArray = Array.from(clients.values());
  for (let i = 0; i < clientsArray.length; i += BATCH_SIZE) {
    const batch = clientsArray.slice(i, i + BATCH_SIZE);
    await supabase.from('clients').upsert(batch, { onConflict: 'email' });
  }

  // Insert transactions
  let txCreated = 0;
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { 
      onConflict: 'source,payment_key',
      ignoreDuplicates: false 
    });
    if (!error) txCreated += batch.length;
  }

  return { 
    type: 'stripe_payments', 
    clientsCreated: clients.size, 
    clientsUpdated: 0, 
    transactionsCreated: txCreated, 
    errors: [] 
  };
}

// Process Stripe Customers CSV (LTV)
async function processStripeCustomers(supabase: any, csvText: string): Promise<ProcessingResult['result']> {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    return { type: 'stripe_customers', clientsCreated: 0, clientsUpdated: 0, errors: ['CSV vacío'] };
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const emailIdx = headers.findIndex(h => h === 'email');
  const totalSpendIdx = headers.findIndex(h => h.includes('total spend') || h === 'total_spend');
  const delinquentIdx = headers.findIndex(h => h === 'delinquent');
  const idIdx = headers.findIndex(h => h === 'id');

  const toUpdate: any[] = [];
  const BATCH_SIZE = 1000;

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseCSVLine(lines[i]);
      const email = normalizeEmail(emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim() : '');
      if (!email) continue;

      const totalSpendStr = totalSpendIdx >= 0 ? values[totalSpendIdx]?.replace(/"/g, '').trim() : '0';
      const totalSpend = Math.round(parseFloat(totalSpendStr) * 100);
      const isDelinquent = (delinquentIdx >= 0 ? values[delinquentIdx]?.replace(/"/g, '').trim() : 'false').toLowerCase() === 'true';

      toUpdate.push({
        email,
        total_spend: totalSpend,
        is_delinquent: isDelinquent,
        stripe_customer_id: idIdx >= 0 ? values[idIdx]?.replace(/"/g, '').trim() : null,
        last_sync: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`Error en línea ${i + 1}`, error);
    }
  }

  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (!error) updated += batch.length;
  }

  return { type: 'stripe_customers', clientsCreated: 0, clientsUpdated: updated, errors: [] };
}

// Process PayPal CSV
async function processPayPal(supabase: any, csvText: string): Promise<ProcessingResult['result']> {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    return { type: 'paypal', clientsCreated: 0, clientsUpdated: 0, transactionsCreated: 0, errors: ['CSV vacío'] };
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const transactionIdIdx = headers.findIndex(h => h.includes('transacción') || h.includes('transaction id'));
  const emailIdx = headers.findIndex(h => h.includes('correo') || h.includes('email'));
  const grossIdx = headers.findIndex(h => h === 'bruto' || h === 'gross');
  const netIdx = headers.findIndex(h => h === 'neto' || h === 'net');
  const statusIdx = headers.findIndex(h => h === 'estado' || h === 'status');
  const dateIdx = headers.findIndex(h => h === 'fecha' || h === 'date');

  const transactions: any[] = [];
  const clients = new Map();
  const BATCH_SIZE = 1000;

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseCSVLine(lines[i]);
      const transactionId = values[transactionIdIdx]?.replace(/"/g, '').trim() || '';
      if (!transactionId) continue;

      const email = normalizeEmail(emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim() : '');
      const grossStr = grossIdx >= 0 ? values[grossIdx]?.replace(/"/g, '').trim() : '0';
      const netStr = netIdx >= 0 ? values[netIdx]?.replace(/"/g, '').trim() : grossStr;
      const gross = parseFloat(grossStr);
      const net = parseFloat(netStr);
      const status = (statusIdx >= 0 ? values[statusIdx]?.replace(/"/g, '').trim() : '').toLowerCase();
      const dateTime = dateIdx >= 0 ? values[dateIdx]?.replace(/"/g, '').trim() : '';

      if (!email || gross <= 0) continue;

      transactions.push({
        customer_email: email,
        amount: Math.round(net * 100),
        status: status.includes('complet') || status === 'completed' ? 'paid' : 'pending',
        source: 'paypal',
        payment_key: transactionId,
        external_transaction_id: transactionId,
        paypal_transaction_id: transactionId,
        currency: 'usd',
        created_at: dateTime ? new Date(dateTime).toISOString() : new Date().toISOString()
      });

      if (!clients.has(email)) {
        clients.set(email, {
          email,
          paypal_customer_id: transactionId,
          lifecycle_stage: 'CUSTOMER',
          last_sync: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error(`Error en línea ${i + 1}`, error);
    }
  }

  // Upsert clients
  const clientsArray = Array.from(clients.values());
  for (let i = 0; i < clientsArray.length; i += BATCH_SIZE) {
    const batch = clientsArray.slice(i, i + BATCH_SIZE);
    await supabase.from('clients').upsert(batch, { onConflict: 'email' });
  }

  // Insert transactions
  let txCreated = 0;
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { 
      onConflict: 'source,payment_key',
      ignoreDuplicates: false 
    });
    if (!error) txCreated += batch.length;
  }

  return { 
    type: 'paypal', 
    clientsCreated: clients.size, 
    clientsUpdated: 0, 
    transactionsCreated: txCreated, 
    errors: [] 
  };
}

// Detect CSV type from content
function detectCSVType(csvText: string, filename: string): string {
  const firstLine = csvText.split('\n')[0]?.toLowerCase() || '';
  const lowerFilename = filename.toLowerCase();

  if (firstLine.includes('contact id') || firstLine.includes('contactid') || 
      lowerFilename.includes('ghl') || lowerFilename.includes('gohighlevel') || 
      lowerFilename.includes('export_contacts')) {
    return 'ghl';
  }
  if (firstLine.includes('total spend') || firstLine.includes('total_spend') || 
      firstLine.includes('delinquent') || lowerFilename.includes('unified_customer')) {
    return 'stripe_customers';
  }
  if (firstLine.includes('amount refunded') || firstLine.includes('amount_refunded') ||
      firstLine.includes('payment method type') || lowerFilename.includes('pagos') ||
      lowerFilename.includes('unified_payment')) {
    return 'stripe_payments';
  }
  if (firstLine.includes('correo electrónico del remitente') || 
      firstLine.includes('from email address') || firstLine.includes('bruto') ||
      lowerFilename.includes('download') || lowerFilename.includes('paypal')) {
    return 'paypal';
  }
  if (firstLine.includes('plan name') || firstLine.includes('plan_name') ||
      firstLine.includes('expires at') || lowerFilename.includes('subscription')) {
    return 'subscriptions';
  }
  if (firstLine.includes('email') && (firstLine.includes('nombre') || firstLine.includes('name')) &&
      !firstLine.includes('amount') && !firstLine.includes('payment')) {
    return 'web';
  }

  return 'unknown';
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify admin authentication
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);

    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify admin via RPC
    const { data: isAdmin, error: adminError } = await supabaseAuth.rpc('is_admin');
    if (adminError || !isAdmin) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Forbidden: Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { csvText, filename, type } = await req.json();

    if (!csvText) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing csvText' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Detect type if not provided
    const detectedType = type || detectCSVType(csvText, filename || '');
    logger.info(`Processing CSV type: ${detectedType}`);

    let result: ProcessingResult['result'];

    switch (detectedType) {
      case 'ghl':
        result = await processGHL(supabase, csvText);
        break;
      case 'stripe_payments':
        result = await processStripePayments(supabase, csvText);
        break;
      case 'stripe_customers':
        result = await processStripeCustomers(supabase, csvText);
        break;
      case 'paypal':
        result = await processPayPal(supabase, csvText);
        break;
      default:
        return new Response(
          JSON.stringify({ ok: false, error: `Unsupported CSV type: ${detectedType}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    return new Response(
      JSON.stringify({ ok: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    logger.error('Error processing CSV', error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
