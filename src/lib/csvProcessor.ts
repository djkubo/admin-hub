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
  expiresAt: string; // Added for churn calculation
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
// Use Map with transaction ID as key to prevent duplicates
let paypalTransactionsCache: Map<string, { email: string; amount: number; status: string; date: Date }> = new Map();

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

// ============= PayPal CSV Processing (Optimized with Batch Upsert + Deduplication) =============

export async function processPayPalCSV(csvText: string): Promise<ProcessingResult> {
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

  // Step 1: Parse all rows and prepare data with deduplication by transaction ID
  interface ParsedPayPalRow {
    email: string;
    amount: number;
    status: string;
    transactionDate: Date;
    transactionId: string;
    currency: string;
  }

  const parsedRowsMap = new Map<string, ParsedPayPalRow>();

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['Correo electrónico del remitente']?.trim() || row['From Email Address']?.trim();
    const rawAmount = row['Bruto']?.trim() || row['Gross']?.trim() || '0';
    const rawStatus = row['Estado']?.trim() || row['Status']?.trim() || '';
    const rawDate = row['Fecha y Hora']?.trim() || row['Date Time']?.trim() || row['Fecha']?.trim();
    const transactionId = row['Id. de transacción']?.trim() || row['Transaction ID']?.trim();

    // Skip if no email or no transaction ID
    if (!email || !transactionId) continue;

    // Skip if already in map (deduplicate within same CSV)
    if (parsedRowsMap.has(transactionId)) {
      result.transactionsSkipped++;
      continue;
    }

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

    parsedRowsMap.set(transactionId, { email, amount, status, transactionDate, transactionId, currency });
    
    // Update cache with deduplication by transaction ID
    paypalTransactionsCache.set(transactionId, { email, amount, status, date: transactionDate });
  }

  const parsedRows = Array.from(parsedRowsMap.values());

  // Step 2: Get existing transaction IDs in batch to check duplicates in DB
  const transactionIds = parsedRows.map(r => r.transactionId);
  const { data: existingTransactions } = await supabase
    .from('transactions')
    .select('external_transaction_id')
    .eq('source', 'paypal')
    .in('external_transaction_id', transactionIds);

  const existingTxIds = new Set(existingTransactions?.map(t => t.external_transaction_id) || []);

  // Filter out duplicates that already exist in DB
  const newRows = parsedRows.filter(r => !existingTxIds.has(r.transactionId));
  result.transactionsSkipped += parsedRows.length - newRows.length;

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
    // NEW: Parse Expires At for churn calculation
    const expiresAt = row['Expires At (CDMX)']?.trim() || row['Expires At']?.trim() || row['expires_at']?.trim() || row['Expiration Date']?.trim() || '';
    const email = row['Email']?.trim() || row['email']?.trim() || '';

    if (planName && status) {
      subscriptionDataCache.push({
        email,
        planName,
        status,
        createdAt,
        expiresAt
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

  // ============= KPI 1: Ventas Netas HOY (with deduplication) =============
  
  // Fetch from DB - already deduplicated by stripe_payment_intent_id
  const { data: todayTransactions } = await supabase
    .from('transactions')
    .select('id, amount, status, currency, stripe_created_at, source, stripe_payment_intent_id')
    .gte('stripe_created_at', todayISO)
    .in('status', ['succeeded', 'paid']);

  // Create a Set of transaction IDs from DB to avoid double counting
  const dbTransactionIds = new Set(todayTransactions?.map(t => t.stripe_payment_intent_id) || []);

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

  // Add PayPal from cache only if NOT already in DB (deduplicated by transaction ID)
  for (const [txId, tx] of paypalTransactionsCache) {
    const txDate = new Date(tx.date);
    txDate.setHours(0, 0, 0, 0);
    
    // Only count if: today, paid, and not already in DB
    if (txDate.getTime() === today.getTime() && tx.status === 'paid') {
      const paypalPaymentIntentId = `paypal_${txId}`;
      if (!dbTransactionIds.has(paypalPaymentIntentId)) {
        if (tx.amount > 500) {
          salesTodayMXN += tx.amount;
        } else {
          salesTodayUSD += tx.amount;
        }
      }
    }
  }

  const MXN_TO_USD = 0.05;
  const salesTodayTotal = salesTodayUSD + (salesTodayMXN * MXN_TO_USD);

  // ============= KPI 2: Tasa de Conversión (Fixed: track by email) =============
  
  // Group subscriptions by email
  const emailSubscriptions = new Map<string, SubscriptionData[]>();
  for (const sub of subscriptionDataCache) {
    if (!sub.email) continue;
    const existing = emailSubscriptions.get(sub.email) || [];
    existing.push(sub);
    emailSubscriptions.set(sub.email, existing);
  }

  let trialCount = 0;
  let convertedCount = 0;
  const trialEmails = new Set<string>();

  // First pass: identify trial users
  for (const sub of subscriptionDataCache) {
    const planLower = sub.planName.toLowerCase();
    if (planLower.includes('trial') || planLower.includes('prueba')) {
      trialCount++;
      if (sub.email) {
        trialEmails.add(sub.email);
      }
    }
  }

  // Second pass: count conversions (same email with active paid plan)
  for (const email of trialEmails) {
    const subs = emailSubscriptions.get(email) || [];
    const hasActivePaidPlan = subs.some(sub => {
      const statusLower = sub.status.toLowerCase();
      const planLower = sub.planName.toLowerCase();
      return statusLower === 'active' && 
             !planLower.includes('trial') && 
             !planLower.includes('prueba');
    });
    if (hasActivePaidPlan) {
      convertedCount++;
    }
  }

  const conversionRate = trialCount > 0 ? (convertedCount / trialCount) * 100 : 0;

  // ============= KPI 3: Churn / Bajas (Fixed: use Expires At column) =============
  
  let churnCount = 0;

  for (const sub of subscriptionDataCache) {
    const statusLower = sub.status.toLowerCase();
    
    // Only count expired or canceled subscriptions
    if (statusLower === 'expired' || statusLower === 'canceled' || statusLower === 'pastdue') {
      // Use expiresAt instead of createdAt for churn calculation
      if (sub.expiresAt) {
        const expiresDate = new Date(sub.expiresAt);
        if (!isNaN(expiresDate.getTime()) && expiresDate >= thirtyDaysAgo && expiresDate <= today) {
          churnCount++;
        }
      } else if (sub.createdAt) {
        // Fallback to createdAt if expiresAt not available
        const createdDate = new Date(sub.createdAt);
        if (!isNaN(createdDate.getTime()) && createdDate >= thirtyDaysAgo) {
          churnCount++;
        }
      }
    }
  }

  // ============= Recovery List (Fixed: include requires_payment_method and requires_action) =============
  
  // Query for ALL failed statuses including Stripe technical statuses
  const { data: failedTransactions } = await supabase
    .from('transactions')
    .select('customer_email, amount, source, status, failure_code')
    .in('status', ['failed', 'canceled']);

  // Also get transactions where failure_code indicates requires_payment_method or requires_action
  const { data: pendingPaymentTransactions } = await supabase
    .from('transactions')
    .select('customer_email, amount, source, status, failure_code')
    .in('failure_code', ['requires_payment_method', 'requires_action', 'requires_confirmation']);

  // Combine both queries
  const allFailedTransactions = [
    ...(failedTransactions || []),
    ...(pendingPaymentTransactions || [])
  ];

  // Deduplicate by customer_email + amount to avoid counting same transaction twice
  const seenFailedTx = new Set<string>();
  const uniqueFailedTransactions = allFailedTransactions.filter(tx => {
    const key = `${tx.customer_email}_${tx.amount}_${tx.failure_code}`;
    if (seenFailedTx.has(key)) return false;
    seenFailedTx.add(key);
    return true;
  });

  const failedPayPal = Array.from(paypalTransactionsCache.values()).filter(tx => tx.status === 'failed');

  const allFailedEmails = new Set<string>();
  const failedAmounts: Record<string, { amount: number; source: string }> = {};

  for (const tx of uniqueFailedTransactions) {
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
  
  // For Stripe CSV, use optimized batch processing with deduplication
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

  // Step 1: Parse all rows with deduplication
  interface ParsedStripeRow {
    email: string;
    transactionId: string;
    amount: number;
    status: string;
    date: string;
  }

  const parsedRowsMap = new Map<string, ParsedStripeRow>();

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['email']?.trim() || row['Email']?.trim() || row['customer_email']?.trim();
    const transactionId = row['transaction_id']?.trim() || row['id']?.trim() || row['ID']?.trim() || row['payment_intent']?.trim();
    const rawAmount = row['amount']?.trim() || row['Amount']?.trim() || '0';
    const status = row['status']?.trim() || row['Status']?.trim() || 'pending';
    const date = row['date']?.trim() || row['Date']?.trim() || row['created']?.trim() || row['Created date (UTC)']?.trim() || new Date().toISOString();

    if (!email || !transactionId) continue;

    // Skip duplicates within same CSV
    if (parsedRowsMap.has(transactionId)) {
      result.transactionsSkipped++;
      continue;
    }

    const amount = parseFloat(rawAmount.replace(/[^\d.-]/g, '')) || 0;
    parsedRowsMap.set(transactionId, { email, transactionId, amount, status, date });
  }

  const parsedRows = Array.from(parsedRowsMap.values());

  // Step 2: Check for existing transactions in DB
  const transactionIds = parsedRows.map(r => r.transactionId);
  const { data: existingTransactions } = await supabase
    .from('transactions')
    .select('external_transaction_id')
    .eq('source', 'stripe')
    .in('external_transaction_id', transactionIds);

  const existingTxIds = new Set(existingTransactions?.map(t => t.external_transaction_id) || []);
  const newRows = parsedRows.filter(r => !existingTxIds.has(r.transactionId));
  result.transactionsSkipped += parsedRows.length - newRows.length;

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
