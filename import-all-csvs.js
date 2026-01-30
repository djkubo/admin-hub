// Script para importar TODOS los CSVs directamente a la base de datos
// Ejecutar: node import-all-csvs.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Papa from 'papaparse';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Get Supabase credentials from environment or .env
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.error('❌ Error: Falta SUPABASE_URL');
  console.error('');
  console.error('   Configura la variable de entorno VITE_SUPABASE_URL o SUPABASE_URL');
  console.error('   Puedes obtenerla de Lovable Cloud → Settings → Environment Variables');
  process.exit(1);
}

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ Error: Falta SUPABASE_SERVICE_ROLE_KEY');
  console.error('');
  console.error('   Necesitas obtener el Service Role Key de Lovable Cloud:');
  console.error('   1. Ve a Lovable Cloud → Settings → Environment Variables');
  console.error('   2. Busca SUPABASE_SERVICE_ROLE_KEY');
  console.error('   3. Cópialo y ejecuta:');
  console.error('      export SUPABASE_SERVICE_ROLE_KEY="tu-key-aqui"');
  console.error('      node import-all-csvs.js');
  console.error('');
  console.error('   O agrégalo al archivo .env:');
  console.error('   SUPABASE_SERVICE_ROLE_KEY=tu-key-aqui');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const CSV_DIR = '/Users/gustavogarcia/Downloads/SUBIR A LOVABLE';
const BATCH_SIZE = 1000;

// Helper functions
function normalizePhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 10) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function normalizeEmail(email) {
  if (!email) return null;
  const normalized = email.toLowerCase().trim();
  return normalized.includes('@') ? normalized : null;
}

// ============= GHL CSV Processing =============
async function processGHLCSV(filePath) {
  console.log(`\n📥 Procesando GHL CSV: ${path.basename(filePath)}`);
  
  const csvText = fs.readFileSync(filePath, 'utf8');
  const lines = csvText.split('\n').filter(l => l.trim());
  
  if (lines.length < 2) {
    console.log('❌ CSV vacío o sin datos');
    return { created: 0, updated: 0, errors: [] };
  }

  // Parse header
  const headerLine = lines[0];
  const parseCSVLine = (line) => {
    const result = [];
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
  };

  const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().replace(/"/g, '').trim());
  
  const contactIdIdx = headers.findIndex(h => h.includes('contact id') || h === 'id');
  const emailIdx = headers.findIndex(h => h === 'email');
  const phoneIdx = headers.findIndex(h => h === 'phone');
  const firstNameIdx = headers.findIndex(h => h.includes('first name') || h === 'firstname');
  const lastNameIdx = headers.findIndex(h => h.includes('last name') || h === 'lastname');
  const tagsIdx = headers.findIndex(h => h === 'tags' || h === 'tag');

  if (contactIdIdx === -1) {
    console.log('❌ No se encontró columna Contact Id');
    return { created: 0, updated: 0, errors: [] };
  }

  // Parse contacts
  const contacts = [];
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
        console.log(`   📊 Parseados: ${i}/${lines.length - 1} líneas`);
      }
    } catch (error) {
      console.error(`   ⚠️  Error en línea ${i + 1}:`, error.message);
    }
  }

  console.log(`✅ ${contacts.length} contactos parseados`);

  // Load existing by email (optimized for large datasets)
  const emailContacts = contacts.filter(c => c.email);
  const uniqueEmails = [...new Set(emailContacts.map(c => c.email))];
  const existingByEmail = new Map();

  console.log(`📥 Cargando ${uniqueEmails.length} clientes existentes por email...`);
  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.from('clients').select('email').in('email', batch);
    
    if (error) {
      console.error(`   ⚠️  Error cargando batch ${Math.floor(i / BATCH_SIZE) + 1}:`, error.message);
    } else {
      data?.forEach(c => existingByEmail.set(c.email, c));
    }
    
    if (i % 50000 === 0 && i > 0) {
      console.log(`   📊 Cargados: ${i}/${uniqueEmails.length}`);
    }
  }

  // Prepare upserts
  const toUpsert = [];
  let created = 0;
  let updated = 0;

  for (const contact of emailContacts) {
    const existing = existingByEmail.get(contact.email);
    if (existing) {
      updated++;
    } else {
      created++;
    }
    toUpsert.push(contact);
  }

  // Process phone-only contacts (batch lookup)
  const phoneOnlyContacts = contacts.filter(c => !c.email && c.phone);
  if (phoneOnlyContacts.length > 0) {
    console.log(`📥 Cargando ${phoneOnlyContacts.length} clientes existentes por teléfono...`);
    const uniquePhones = [...new Set(phoneOnlyContacts.map(c => c.phone))];
    const existingByPhone = new Map();
    
    for (let i = 0; i < uniquePhones.length; i += BATCH_SIZE) {
      const batch = uniquePhones.slice(i, i + BATCH_SIZE);
      const { data } = await supabase.from('clients').select('id,email,phone').in('phone', batch);
      data?.forEach(c => {
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
  }

  // Execute upserts
  console.log(`💾 Insertando/Actualizando ${toUpsert.length} contactos...`);
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    
    if (error) {
      console.error(`   ❌ Error en batch ${Math.floor(i / BATCH_SIZE) + 1}:`, error.message);
    } else {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      if (batchNum % 10 === 0 || batchNum === 1) {
        console.log(`   ✅ Batch ${batchNum}/${Math.ceil(toUpsert.length / BATCH_SIZE)} completado`);
      }
    }
  }

  console.log(`✅ GHL CSV completado: ${created} nuevos, ${updated} actualizados`);
  return { created, updated, errors: [] };
}

// ============= Stripe Payments CSV Processing =============
async function processStripePaymentsCSV(filePath) {
  console.log(`\n📥 Procesando Stripe Payments CSV: ${path.basename(filePath)}`);
  
  const csvText = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  
  console.log(`📊 ${parsed.data.length} transacciones encontradas`);

  const transactions = [];
  const clients = new Map();

  for (const row of parsed.data) {
    const id = row['id'] || row['ID'] || '';
    if (!id) continue;

    const email = normalizeEmail(row['Customer Email'] || row['customer_email'] || row['email'] || '');
    const amount = parseFloat(row['Amount'] || row['amount'] || '0') * 100; // Convert to cents
    const status = (row['Status'] || row['status'] || '').toLowerCase();
    const currency = (row['Currency'] || row['currency'] || 'usd').toLowerCase();
    const createdAt = row['Created date (UTC)'] || row['Created (UTC)'] || row['created_at'] || '';

    if (!email || amount <= 0) continue;

    transactions.push({
      customer_email: email,
      amount: Math.round(amount),
      status: status === 'paid' || status === 'succeeded' ? 'paid' : status,
      source: 'stripe',
      payment_key: id,
      external_transaction_id: id,
      stripe_payment_intent_id: id,
      currency,
      created_at: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
      raw_data: row
    });

    // Prepare client update
    if (!clients.has(email)) {
      clients.set(email, {
        email,
        stripe_customer_id: row['Customer ID'] || row['customer_id'] || null,
        lifecycle_stage: status === 'paid' || status === 'succeeded' ? 'CUSTOMER' : 'LEAD',
        last_sync: new Date().toISOString()
      });
    }
  }

  // Upsert clients
  console.log(`💾 Insertando/Actualizando ${clients.size} clientes...`);
  const clientsArray = Array.from(clients.values());
  for (let i = 0; i < clientsArray.length; i += BATCH_SIZE) {
    const batch = clientsArray.slice(i, i + BATCH_SIZE);
    await supabase.from('clients').upsert(batch, { onConflict: 'email' });
  }

  // Insert transactions
  console.log(`💾 Insertando ${transactions.length} transacciones...`);
  let txCreated = 0;
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { 
      onConflict: 'source,payment_key',
      ignoreDuplicates: false 
    });
    
    if (!error) {
      txCreated += batch.length;
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      if (batchNum % 10 === 0 || batchNum === 1) {
        console.log(`   ✅ Batch ${batchNum}/${Math.ceil(transactions.length / BATCH_SIZE)}: ${txCreated} transacciones`);
      }
    }
  }

  console.log(`✅ Stripe Payments CSV completado: ${txCreated} transacciones`);
  return { transactionsCreated: txCreated, clientsCreated: clients.size };
}

// ============= Stripe Customers CSV Processing =============
async function processStripeCustomersCSV(filePath) {
  console.log(`\n📥 Procesando Stripe Customers CSV: ${path.basename(filePath)}`);
  
  const csvText = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  
  console.log(`📊 ${parsed.data.length} clientes encontrados`);

  const toUpdate = [];
  
  for (const row of parsed.data) {
    const email = normalizeEmail(row['Email'] || row['email'] || '');
    if (!email) continue;

    const totalSpend = parseFloat(row['Total Spend'] || row['total_spend'] || '0') * 100;
    const isDelinquent = (row['Delinquent'] || row['delinquent'] || 'false').toLowerCase() === 'true';

    toUpdate.push({
      email,
      total_spend: Math.round(totalSpend),
      is_delinquent: isDelinquent,
      stripe_customer_id: row['id'] || row['ID'] || null,
      last_sync: new Date().toISOString()
    });
  }

  console.log(`💾 Actualizando ${toUpdate.length} clientes con LTV...`);
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('clients').upsert(batch, { onConflict: 'email' });
    if (!error) {
      updated += batch.length;
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      if (batchNum % 10 === 0 || batchNum === 1) {
        console.log(`   ✅ Batch ${batchNum}/${Math.ceil(toUpdate.length / BATCH_SIZE)}: ${updated} actualizados`);
      }
    }
  }

  console.log(`✅ Stripe Customers CSV completado: ${updated} clientes actualizados`);
  return { clientsUpdated: updated };
}

// ============= PayPal CSV Processing =============
async function processPayPalCSV(filePath) {
  console.log(`\n📥 Procesando PayPal CSV: ${path.basename(filePath)}`);
  
  const csvText = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  
  console.log(`📊 ${parsed.data.length} transacciones encontradas`);

  const transactions = [];
  const clients = new Map();

  for (const row of parsed.data) {
    const transactionId = row['Id. de transacción'] || row['transaction id'] || row['Transaction ID'] || '';
    if (!transactionId) continue;

    const email = normalizeEmail(
      row['Correo electrónico del destinatario'] || 
      row['Correo electrónico del remitente'] ||
      row['To Email Address'] ||
      row['From Email Address'] ||
      ''
    );
    
    const gross = parseFloat(row['Bruto'] || row['Gross'] || row['gross'] || '0');
    const net = parseFloat(row['Neto'] || row['Net'] || row['net'] || '0');
    const status = (row['Estado'] || row['Status'] || row['status'] || '').toLowerCase();
    const dateTime = row['Fecha'] || row['Date'] || row['Fecha y hora'] || '';

    if (!email || gross <= 0) continue;

    transactions.push({
      customer_email: email,
      amount: Math.round(net * 100), // Convert to cents
      status: status.includes('complet') || status === 'completed' ? 'paid' : 'pending',
      source: 'paypal',
      payment_key: transactionId,
      external_transaction_id: transactionId,
      paypal_transaction_id: transactionId,
      currency: 'usd',
      created_at: dateTime ? new Date(dateTime).toISOString() : new Date().toISOString(),
      raw_data: row
    });

    if (!clients.has(email)) {
      clients.set(email, {
        email,
        paypal_customer_id: transactionId,
        lifecycle_stage: 'CUSTOMER',
        last_sync: new Date().toISOString()
      });
    }
  }

  // Upsert clients
  console.log(`💾 Insertando/Actualizando ${clients.size} clientes...`);
  const clientsArray = Array.from(clients.values());
  for (let i = 0; i < clientsArray.length; i += BATCH_SIZE) {
    const batch = clientsArray.slice(i, i + BATCH_SIZE);
    await supabase.from('clients').upsert(batch, { onConflict: 'email' });
  }

  // Insert transactions
  console.log(`💾 Insertando ${transactions.length} transacciones...`);
  let txCreated = 0;
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').upsert(batch, { 
      onConflict: 'source,payment_key',
      ignoreDuplicates: false 
    });
    
    if (!error) {
      txCreated += batch.length;
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      if (batchNum % 10 === 0 || batchNum === 1) {
        console.log(`   ✅ Batch ${batchNum}/${Math.ceil(transactions.length / BATCH_SIZE)}: ${txCreated} transacciones`);
      }
    }
  }

  console.log(`✅ PayPal CSV completado: ${txCreated} transacciones`);
  return { transactionsCreated: txCreated, clientsCreated: clients.size };
}

// ============= Subscriptions CSV Processing =============
async function processSubscriptionsCSV(filePath) {
  console.log(`\n📥 Procesando Subscriptions CSV: ${path.basename(filePath)}`);
  
  const csvText = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  
  console.log(`📊 ${parsed.data.length} suscripciones encontradas`);

  const subscriptions = [];
  
  for (const row of parsed.data) {
    const email = normalizeEmail(row['Email'] || row['email'] || '');
    if (!email) continue;

    const planName = row['Plan Name'] || row['plan_name'] || row['Plan'] || '';
    const status = (row['Status'] || row['status'] || 'active').toLowerCase();
    const price = parseFloat(row['Price'] || row['price'] || '0') * 100;
    const createdAt = row['Created At (CDMX)'] || row['Created At'] || row['created_at'] || '';
    const expiresAt = row['Expires At (CDMX)'] || row['Expires At'] || row['expires_at'] || '';

    subscriptions.push({
      customer_email: email,
      plan_name: planName,
      status,
      price_cents: Math.round(price),
      created_at: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      raw_data: row
    });
  }

  console.log(`💾 Insertando ${subscriptions.length} suscripciones...`);
  let created = 0;
  for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
    const batch = subscriptions.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('subscriptions').upsert(batch, { 
      onConflict: 'customer_email,plan_name',
      ignoreDuplicates: false 
    });
    
    if (!error) {
      created += batch.length;
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      if (batchNum % 10 === 0 || batchNum === 1) {
        console.log(`   ✅ Batch ${batchNum}/${Math.ceil(subscriptions.length / BATCH_SIZE)}: ${created} suscripciones`);
      }
    }
  }

  console.log(`✅ Subscriptions CSV completado: ${created} suscripciones`);
  return { subscriptionsCreated: created };
}

// ============= Web Users CSV Processing =============
async function processWebUsersCSV(filePath) {
  console.log(`\n📥 Procesando Web Users CSV: ${path.basename(filePath)}`);
  
  const csvText = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  
  console.log(`📊 ${parsed.data.length} usuarios encontrados`);

  const users = [];
  
  for (const row of parsed.data) {
    const email = normalizeEmail(row['Email'] || row['email'] || row['Correo'] || '');
    if (!email) continue;

    const phone = normalizePhone(row['Telefono'] || row['telefono'] || row['Phone'] || row['phone'] || '');
    const fullName = row['Nombre'] || row['nombre'] || row['Name'] || row['name'] || '';

    users.push({
      email,
      phone,
      full_name: fullName || null,
      acquisition_source: 'web',
      lifecycle_stage: 'LEAD',
      last_sync: new Date().toISOString()
    });
  }

  console.log(`💾 Insertando/Actualizando ${users.length} usuarios...`);
  let created = 0;
  let updated = 0;
  
  // Load existing
  const uniqueEmails = [...new Set(users.map(u => u.email))];
  const existingByEmail = new Map();
  
  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const { data } = await supabase.from('clients').select('email').in('email', batch);
    data?.forEach(c => existingByEmail.set(c.email, c));
  }

  for (const user of users) {
    if (existingByEmail.has(user.email)) {
      updated++;
    } else {
      created++;
    }
  }

  // Upsert
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    await supabase.from('clients').upsert(batch, { onConflict: 'email' });
  }

  console.log(`✅ Web Users CSV completado: ${created} nuevos, ${updated} actualizados`);
  return { clientsCreated: created, clientsUpdated: updated };
}

// ============= MAIN =============
async function main() {
  console.log('🚀 Iniciando importación masiva de CSVs...\n');
  console.log(`📁 Directorio: ${CSV_DIR}\n`);

  // Auto-detect files in directory
  const allFiles = fs.readdirSync(CSV_DIR).filter(f => 
    f.toLowerCase().endsWith('.csv') || f.toUpperCase().endsWith('.CSV')
  );
  
  console.log(`📁 Archivos encontrados: ${allFiles.length}`);
  allFiles.forEach(f => console.log(`   - ${f}`));
  console.log('');

  // Map files to types
  const files = [];
  for (const fileName of allFiles) {
    const lowerName = fileName.toLowerCase();
    let type = null;
    
    if (lowerName.includes('export_contacts') || lowerName.includes('ghl') || lowerName.includes('gohighlevel')) {
      type = 'ghl';
    } else if (lowerName.includes('unified_customer') || lowerName.includes('customers')) {
      type = 'stripe_customers';
    } else if (lowerName.includes('unified_payment') || lowerName.includes('pagos') || 
               (lowerName.includes('payment') && !lowerName.includes('customer'))) {
      type = 'stripe_payments';
    } else if (lowerName.includes('subscription')) {
      type = 'subscriptions';
    } else if (lowerName.includes('download') || lowerName.includes('paypal')) {
      type = 'paypal';
    } else if (lowerName.includes('user')) {
      type = 'web';
    }
    
    if (type) {
      files.push({ name: fileName, type });
      console.log(`✅ ${fileName} → ${type}`);
    } else {
      console.log(`⚠️  ${fileName} → tipo desconocido (se omitirá)`);
    }
  }
  
  console.log('');

  const results = {
    ghl: { created: 0, updated: 0 },
    web: { created: 0, updated: 0 },
    stripe_customers: { updated: 0 },
    stripe_payments: { transactions: 0, clients: 0 },
    subscriptions: { created: 0 },
    paypal: { transactions: 0, clients: 0 }
  };

  // Process in order
  for (const file of files) {
    const filePath = path.join(CSV_DIR, file.name);
    
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  Archivo no encontrado: ${file.name}`);
      continue;
    }

    try {
      switch (file.type) {
        case 'ghl':
          const ghlResult = await processGHLCSV(filePath);
          results.ghl.created += ghlResult.created;
          results.ghl.updated += ghlResult.updated;
          break;
        case 'web':
          const webResult = await processWebUsersCSV(filePath);
          results.web.created += webResult.clientsCreated;
          results.web.updated += webResult.clientsUpdated;
          break;
        case 'stripe_customers':
          const customersResult = await processStripeCustomersCSV(filePath);
          results.stripe_customers.updated += customersResult.clientsUpdated;
          break;
        case 'stripe_payments':
          const paymentsResult = await processStripePaymentsCSV(filePath);
          results.stripe_payments.transactions += paymentsResult.transactionsCreated;
          results.stripe_payments.clients += paymentsResult.clientsCreated;
          break;
        case 'subscriptions':
          const subsResult = await processSubscriptionsCSV(filePath);
          results.subscriptions.created += subsResult.subscriptionsCreated;
          break;
        case 'paypal':
          const paypalResult = await processPayPalCSV(filePath);
          results.paypal.transactions += paypalResult.transactionsCreated;
          results.paypal.clients += paypalResult.clientsCreated;
          break;
      }
    } catch (error) {
      console.error(`❌ Error procesando ${file.name}:`, error.message);
      console.error(error.stack);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESUMEN FINAL');
  console.log('='.repeat(60));
  console.log(`GHL: ${results.ghl.created} nuevos, ${results.ghl.updated} actualizados`);
  console.log(`Web Users: ${results.web.created} nuevos, ${results.web.updated} actualizados`);
  console.log(`Stripe Customers: ${results.stripe_customers.updated} actualizados`);
  console.log(`Stripe Payments: ${results.stripe_payments.transactions} transacciones, ${results.stripe_payments.clients} clientes`);
  console.log(`Subscriptions: ${results.subscriptions.created} suscripciones`);
  console.log(`PayPal: ${results.paypal.transactions} transacciones, ${results.paypal.clients} clientes`);
  console.log('='.repeat(60));
  console.log('✅ Importación completada!\n');
}

main().catch(console.error);
