import Papa from 'papaparse';
import { supabase } from "@/integrations/supabase/client";

// ============= Constants =============
const BATCH_SIZE = 500;

// ============= Interfaces =============

export interface ProcessingResult {
  clientsCreated: number;
  clientsUpdated: number;
  transactionsCreated: number;
  transactionsSkipped: number;
  errors: string[];
}

export interface SubscriptionData {
  email?: string;
  planName: string;
  status: string;
  createdAt: string;
}

export interface RecoveryClient {
  email: string;
  full_name: string | null;
  phone: string | null;
  amount: number;
  source: string;
}

export interface DashboardMetrics {
  salesTodayUSD: number;
  salesTodayMXN: number;
  salesTodayTotal: number;
  conversionRate: number;
  trialCount: number;
  convertedCount: number;
  churnCount: number;
  recoveryList: RecoveryClient[];
}

// Store subscription data in memory for metrics calculation
let subscriptionDataCache: SubscriptionData[] = [];
let paypalTransactionsCache: { email: string; amount: number; status: string; date: Date }[] = [];

// ============= Helper: Process in batches =============

async function processBatches<T>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<{ success: number; errors: string[] }>
): Promise<{ totalSuccess: number; allErrors: string[] }> {
  let totalSuccess = 0;
  const allErrors: string[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const result = await processor(batch);
    totalSuccess += result.success;
    allErrors.push(...result.errors);
  }

  return { totalSuccess, allErrors };
}

// ============= PayPal CSV Processing (Optimized with Batch Upsert) =============

export async function processPayPalCSV(csvText: string): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: []
  };

  // Reset cache
  paypalTransactionsCache = [];

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  // Step 1: Parse all rows and prepare data
  interface ParsedPayPalRow {
    email: string;
    amount: number;
    status: string;
    transactionDate: Date;
    transactionId: string;
    currency: string;
  }

  const parsedRows: ParsedPayPalRow[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['Correo electrónico del remitente']?.trim() || row['From Email Address']?.trim();
    const rawAmount = row['Bruto']?.trim() || row['Gross']?.trim() || '0';
    const rawStatus = row['Estado']?.trim() || row['Status']?.trim() || '';
    const rawDate = row['Fecha y Hora']?.trim() || row['Date Time']?.trim() || row['Fecha']?.trim();
    const transactionId = row['Id. de transacción']?.trim() || row['Transaction ID']?.trim() || `paypal_${Date.now()}_${Math.random()}`;

    if (!email) continue;

    const cleanedAmount = rawAmount.replace(/[^\d.-]/g, '').replace(',', '.');
    const amount = parseFloat(cleanedAmount) || 0;

    let status = 'pending';
    const lowerStatus = rawStatus.toLowerCase();
    if (lowerStatus.includes('completado') || lowerStatus.includes('completed')) {
      status = 'paid';
    } else if (lowerStatus.includes('declinado') || lowerStatus.includes('rechazado') || 
               lowerStatus.includes('cancelado') || lowerStatus.includes('declined') ||
               lowerStatus.includes('rejected') || lowerStatus.includes('canceled')) {
      status = 'failed';
    }

    let transactionDate = new Date();
    if (rawDate) {
      const parsedDate = new Date(rawDate);
      if (!isNaN(parsedDate.getTime())) {
        transactionDate = parsedDate;
      }
    }

    const currency = rawAmount.toLowerCase().includes('mxn') ? 'mxn' : 'usd';

    parsedRows.push({ email, amount, status, transactionDate, transactionId, currency });
    paypalTransactionsCache.push({ email, amount, status, date: transactionDate });
  }

  // Step 2: Get existing transaction IDs in batch to check duplicates
  const transactionIds = parsedRows.map(r => r.transactionId);
  const { data: existingTransactions } = await supabase
    .from('transactions')
    .select('external_transaction_id')
    .eq('source', 'paypal')
    .in('external_transaction_id', transactionIds);

  const existingTxIds = new Set(existingTransactions?.map(t => t.external_transaction_id) || []);

  // Filter out duplicates
  const newRows = parsedRows.filter(r => !existingTxIds.has(r.transactionId));
  result.transactionsSkipped = parsedRows.length - newRows.length;

  // Step 3: Get all unique emails and fetch existing clients in batch
  const uniqueEmails = [...new Set(newRows.map(r => r.email))];
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails);

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Step 4: Prepare clients for upsert (batch)
  const clientsToUpsert: Array<{
    email: string;
    payment_status: string;
    total_paid: number;
    status: string;
    last_sync: string;
  }> = [];

  // Aggregate payments per email
  const emailPayments = new Map<string, { paidAmount: number; hasFailed: boolean }>();
  for (const row of newRows) {
    const existing = emailPayments.get(row.email) || { paidAmount: 0, hasFailed: false };
    if (row.status === 'paid') {
      existing.paidAmount += row.amount;
    }
    if (row.status === 'failed') {
      existing.hasFailed = true;
    }
    emailPayments.set(row.email, existing);
  }

  for (const [email, payments] of emailPayments) {
    const existingClient = clientMap.get(email);
    const newTotalPaid = (existingClient?.total_paid || 0) + payments.paidAmount;
    
    let paymentStatus = existingClient?.payment_status || 'none';
    if (payments.paidAmount > 0) {
      paymentStatus = 'paid';
    } else if (payments.hasFailed && paymentStatus !== 'paid') {
      paymentStatus = 'failed';
    }

    clientsToUpsert.push({
      email,
      payment_status: paymentStatus,
      total_paid: newTotalPaid,
      status: existingClient?.status || 'active',
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

  // Step 5: Batch upsert clients
  if (clientsToUpsert.length > 0) {
    const clientBatchResult = await processBatches(clientsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'email', ignoreDuplicates: false });
      
      if (error) {
        return { success: 0, errors: [`Error batch upsert clients: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.errors.push(...clientBatchResult.allErrors);
  }

  // Step 6: Prepare transactions for batch insert
  const transactionsToInsert = newRows.map(row => ({
    customer_email: row.email,
    amount: Math.round(row.amount * 100),
    status: row.status,
    source: 'paypal',
    external_transaction_id: row.transactionId,
    stripe_payment_intent_id: `paypal_${row.transactionId}`,
    stripe_created_at: row.transactionDate.toISOString(),
    currency: row.currency,
    failure_code: row.status === 'failed' ? 'payment_failed' : null,
    failure_message: row.status === 'failed' ? 'Pago rechazado/declinado por PayPal' : null
  }));

  // Step 7: Batch insert transactions
  if (transactionsToInsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToInsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('transactions')
        .insert(batch);
      
      if (error) {
        return { success: 0, errors: [`Error batch insert transactions: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.transactionsCreated = txBatchResult.totalSuccess;
    result.errors.push(...txBatchResult.allErrors);
  }

  return result;
}

// ============= Web Users CSV Processing (Optimized with Batch Upsert) =============

export async function processWebUsersCSV(csvText: string): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: []
  };

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  // Step 1: Parse all rows
  interface ParsedWebUser {
    email: string;
    phone: string | null;
    fullName: string | null;
  }

  const parsedRows: ParsedWebUser[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['Email']?.trim() || row['email']?.trim() || row['Correo']?.trim();
    const phone = row['Telefono']?.trim() || row['telefono']?.trim() || row['Phone']?.trim() || row['Teléfono']?.trim() || null;
    const fullName = row['Nombre']?.trim() || row['nombre']?.trim() || row['Name']?.trim() || row['Nombre completo']?.trim() || null;

    if (!email) continue;
    parsedRows.push({ email, phone, fullName });
  }

  // Step 2: Get existing clients in batch
  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails);

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Step 3: Prepare clients for upsert - merge data from multiple rows with same email
  const emailDataMap = new Map<string, ParsedWebUser>();
  for (const row of parsedRows) {
    const existing = emailDataMap.get(row.email);
    if (existing) {
      // Merge: prefer non-null values
      emailDataMap.set(row.email, {
        email: row.email,
        phone: row.phone || existing.phone,
        fullName: row.fullName || existing.fullName
      });
    } else {
      emailDataMap.set(row.email, row);
    }
  }

  const clientsToUpsert: Array<{
    email: string;
    phone: string | null;
    full_name: string | null;
    status: string;
    last_sync: string;
  }> = [];

  for (const [email, data] of emailDataMap) {
    const existingClient = clientMap.get(email);
    
    clientsToUpsert.push({
      email,
      phone: data.phone || existingClient?.phone || null,
      full_name: data.fullName || existingClient?.full_name || null,
      status: existingClient?.status || 'active',
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

  // Step 4: Batch upsert clients
  if (clientsToUpsert.length > 0) {
    const batchResult = await processBatches(clientsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'email', ignoreDuplicates: false });
      
      if (error) {
        return { success: 0, errors: [`Error batch upsert: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.errors.push(...batchResult.allErrors);
  }

  return result;
}

// ============= Subscriptions CSV Processing =============

export function processSubscriptionsCSV(csvText: string): SubscriptionData[] {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  subscriptionDataCache = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const planName = row['Plan Name']?.trim() || row['plan_name']?.trim() || '';
    const status = row['Status']?.trim() || row['status']?.trim() || '';
    const createdAt = row['Created At (CDMX)']?.trim() || row['Created At']?.trim() || row['created_at']?.trim() || '';
    const email = row['Email']?.trim() || row['email']?.trim() || '';

    if (planName && status) {
      subscriptionDataCache.push({
        email,
        planName,
        status,
        createdAt
      });
    }
  }

  return subscriptionDataCache;
}

// ============= Metrics Calculation =============

export async function getMetrics(): Promise<DashboardMetrics> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // ============= KPI 1: Ventas Netas HOY =============
  
  const { data: todayTransactions } = await supabase
    .from('transactions')
    .select('amount, status, currency, stripe_created_at, source')
    .gte('stripe_created_at', todayISO)
    .in('status', ['succeeded', 'paid']);

  let salesTodayUSD = 0;
  let salesTodayMXN = 0;

  for (const tx of todayTransactions || []) {
    const amountInCurrency = tx.amount / 100;
    if (tx.currency?.toLowerCase() === 'mxn') {
      salesTodayMXN += amountInCurrency;
    } else {
      salesTodayUSD += amountInCurrency;
    }
  }

  // Also add any PayPal from memory cache (for freshly uploaded CSVs not yet persisted)
  const todayPayPalCache = paypalTransactionsCache.filter(tx => {
    const txDate = new Date(tx.date);
    txDate.setHours(0, 0, 0, 0);
    return txDate.getTime() === today.getTime() && tx.status === 'paid';
  });

  for (const tx of todayPayPalCache) {
    const alreadyInDB = todayTransactions?.some(dbTx => 
      dbTx.source === 'paypal' && Math.abs(dbTx.amount / 100 - tx.amount) < 0.01
    );
    if (!alreadyInDB) {
      if (tx.amount > 500) {
        salesTodayMXN += tx.amount;
      } else {
        salesTodayUSD += tx.amount;
      }
    }
  }

  const MXN_TO_USD = 0.05;
  const salesTodayTotal = salesTodayUSD + (salesTodayMXN * MXN_TO_USD);

  // ============= KPI 2: Tasa de Conversión =============
  
  let trialCount = 0;
  let convertedCount = 0;

  for (const sub of subscriptionDataCache) {
    const planLower = sub.planName.toLowerCase();
    const statusLower = sub.status.toLowerCase();
    
    if (planLower.includes('trial') || planLower.includes('prueba')) {
      trialCount++;
    }
    
    if (statusLower === 'active' && !planLower.includes('trial') && !planLower.includes('prueba')) {
      convertedCount++;
    }
  }

  const conversionRate = trialCount > 0 ? (convertedCount / trialCount) * 100 : 0;

  // ============= KPI 3: Churn / Bajas =============
  
  let churnCount = 0;

  for (const sub of subscriptionDataCache) {
    const statusLower = sub.status.toLowerCase();
    
    if (statusLower === 'expired' || statusLower === 'canceled' || statusLower === 'pastdue') {
      if (sub.createdAt) {
        const createdDate = new Date(sub.createdAt);
        if (createdDate >= thirtyDaysAgo) {
          churnCount++;
        }
      } else {
        churnCount++;
      }
    }
  }

  // ============= Recovery List =============
  
  const { data: failedTransactions } = await supabase
    .from('transactions')
    .select('customer_email, amount, source')
    .in('status', ['failed', 'canceled']);

  const failedPayPal = paypalTransactionsCache.filter(tx => tx.status === 'failed');

  const allFailedEmails = new Set<string>();
  const failedAmounts: Record<string, { amount: number; source: string }> = {};

  for (const tx of failedTransactions || []) {
    if (tx.customer_email) {
      allFailedEmails.add(tx.customer_email);
      if (!failedAmounts[tx.customer_email]) {
        failedAmounts[tx.customer_email] = { amount: 0, source: tx.source || 'stripe' };
      }
      failedAmounts[tx.customer_email].amount += tx.amount / 100;
    }
  }

  for (const tx of failedPayPal) {
    allFailedEmails.add(tx.email);
    if (!failedAmounts[tx.email]) {
      failedAmounts[tx.email] = { amount: 0, source: 'paypal' };
    } else {
      failedAmounts[tx.email].source = 'stripe/paypal';
    }
    failedAmounts[tx.email].amount += tx.amount;
  }

  const recoveryList: RecoveryClient[] = [];

  if (allFailedEmails.size > 0) {
    const { data: clients } = await supabase
      .from('clients')
      .select('email, full_name, phone')
      .in('email', Array.from(allFailedEmails));

    for (const client of clients || []) {
      if (client.email) {
        const failedInfo = failedAmounts[client.email];
        if (failedInfo) {
          recoveryList.push({
            email: client.email,
            full_name: client.full_name,
            phone: client.phone,
            amount: failedInfo.amount,
            source: failedInfo.source
          });
        }
      }
    }

    for (const email of allFailedEmails) {
      if (!recoveryList.find(r => r.email === email)) {
        const failedInfo = failedAmounts[email];
        recoveryList.push({
          email,
          full_name: null,
          phone: null,
          amount: failedInfo?.amount || 0,
          source: failedInfo?.source || 'unknown'
        });
      }
    }
  }

  return {
    salesTodayUSD,
    salesTodayMXN,
    salesTodayTotal,
    conversionRate,
    trialCount,
    convertedCount,
    churnCount,
    recoveryList
  };
}

// ============= Legacy function for backward compatibility =============

export async function processWebCSV(csvText: string): Promise<ProcessingResult> {
  return processWebUsersCSV(csvText);
}

export async function processPaymentCSV(
  csvText: string, 
  source: 'stripe' | 'paypal'
): Promise<ProcessingResult> {
  if (source === 'paypal') {
    return processPayPalCSV(csvText);
  }
  
  // For Stripe CSV, use optimized batch processing
  const result: ProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: []
  };

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  // Step 1: Parse all rows
  interface ParsedStripeRow {
    email: string;
    transactionId: string;
    amount: number;
    status: string;
    date: string;
  }

  const parsedRows: ParsedStripeRow[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['email']?.trim() || row['Email']?.trim() || row['customer_email']?.trim();
    const transactionId = row['transaction_id']?.trim() || row['id']?.trim() || row['ID']?.trim();
    const rawAmount = row['amount']?.trim() || row['Amount']?.trim() || '0';
    const status = row['status']?.trim() || row['Status']?.trim() || 'pending';
    const date = row['date']?.trim() || row['Date']?.trim() || row['created']?.trim() || new Date().toISOString();

    if (!email || !transactionId) continue;

    const amount = parseFloat(rawAmount.replace(/[^\d.-]/g, '')) || 0;
    parsedRows.push({ email, transactionId, amount, status, date });
  }

  // Step 2: Check for existing transactions in batch
  const transactionIds = parsedRows.map(r => r.transactionId);
  const { data: existingTransactions } = await supabase
    .from('transactions')
    .select('external_transaction_id')
    .eq('source', 'stripe')
    .in('external_transaction_id', transactionIds);

  const existingTxIds = new Set(existingTransactions?.map(t => t.external_transaction_id) || []);
  const newRows = parsedRows.filter(r => !existingTxIds.has(r.transactionId));
  result.transactionsSkipped = parsedRows.length - newRows.length;

  // Step 3: Get existing clients in batch
  const uniqueEmails = [...new Set(newRows.map(r => r.email))];
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails);

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Step 4: Aggregate payments per email and prepare client upserts
  const emailPayments = new Map<string, { paidAmount: number; hasFailed: boolean }>();
  for (const row of newRows) {
    const existing = emailPayments.get(row.email) || { paidAmount: 0, hasFailed: false };
    const isPaid = row.status === 'succeeded' || row.status === 'paid';
    if (isPaid) {
      existing.paidAmount += row.amount;
    }
    if (row.status === 'failed') {
      existing.hasFailed = true;
    }
    emailPayments.set(row.email, existing);
  }

  const clientsToUpsert: Array<{
    email: string;
    payment_status: string;
    total_paid: number;
    status: string;
    last_sync: string;
  }> = [];

  for (const [email, payments] of emailPayments) {
    const existingClient = clientMap.get(email);
    const newTotalPaid = (existingClient?.total_paid || 0) + payments.paidAmount;
    
    let paymentStatus = existingClient?.payment_status || 'none';
    if (payments.paidAmount > 0) {
      paymentStatus = 'paid';
    } else if (payments.hasFailed && paymentStatus !== 'paid') {
      paymentStatus = 'failed';
    }

    clientsToUpsert.push({
      email,
      payment_status: paymentStatus,
      total_paid: newTotalPaid,
      status: existingClient?.status || 'active',
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

  // Step 5: Batch upsert clients
  if (clientsToUpsert.length > 0) {
    const clientBatchResult = await processBatches(clientsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'email', ignoreDuplicates: false });
      
      if (error) {
        return { success: 0, errors: [`Error batch upsert clients: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.errors.push(...clientBatchResult.allErrors);
  }

  // Step 6: Prepare transactions for batch insert
  const transactionsToInsert = newRows.map(row => ({
    customer_email: row.email,
    amount: Math.round(row.amount * 100),
    status: row.status,
    source: 'stripe',
    external_transaction_id: row.transactionId,
    stripe_payment_intent_id: `stripe_${row.transactionId}`,
    stripe_created_at: new Date(row.date).toISOString(),
    failure_code: row.status === 'failed' ? 'payment_failed' : null,
    failure_message: row.status === 'failed' ? 'Payment failed' : null
  }));

  // Step 7: Batch insert transactions
  if (transactionsToInsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToInsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('transactions')
        .insert(batch);
      
      if (error) {
        return { success: 0, errors: [`Error batch insert transactions: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.transactionsCreated = txBatchResult.totalSuccess;
    result.errors.push(...txBatchResult.allErrors);
  }

  return result;
}
