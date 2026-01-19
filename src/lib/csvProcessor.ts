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
  salesMonthUSD: number;
  salesMonthMXN: number;
  salesMonthTotal: number;
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
    skipEmptyLines: 'greedy', // Skip ALL empty lines including whitespace-only
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || '' // Trim all values
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
    // Multiple fallbacks for email (PayPal uses different column names)
    const email = row['Correo electrónico del remitente'] || 
                  row['From Email Address'] || 
                  row['Correo electrónico del receptor'] ||
                  row['To Email Address'] ||
                  row['Email'] ||
                  row['email'] || '';
    
    // Multiple fallbacks for amount
    const rawAmount = row['Bruto'] || row['Gross'] || row['Neto'] || row['Net'] || row['Amount'] || '0';
    
    // Multiple fallbacks for status
    const rawStatus = row['Estado'] || row['Status'] || '';
    
    // Multiple fallbacks for date
    const rawDate = row['Fecha y Hora'] || row['Date Time'] || row['Fecha'] || row['Date'] || '';
    
    // Multiple fallbacks for transaction ID
    const transactionId = row['Id. de transacción'] || row['Transaction ID'] || row['Id de transacción'] || '';

    // Silently skip rows without email (summary lines, empty rows, totals)
    if (!email || email.trim() === '') continue;
    
    // Skip if no transaction ID
    if (!transactionId || transactionId.trim() === '') continue;
    
    // Also skip rows that look like summaries (contain only totals text)
    if (email.toLowerCase().includes('total') || email.toLowerCase().includes('subtotal')) continue;

    const trimmedTxId = transactionId.trim();
    const trimmedEmail = email.trim();

    // Skip if already in map (deduplicate within same CSV)
    if (parsedRowsMap.has(trimmedTxId)) {
      result.transactionsSkipped++;
      continue;
    }

    // Clean PayPal amount: remove currency symbols, spaces, and handle comma as decimal/thousands
    const cleanedAmount = rawAmount
      .replace(/[^\d.,-]/g, '')  // Keep only digits, dots, commas, minus
      .replace(/,(\d{2})$/, '.$1')  // Convert trailing comma decimal (European format)
      .replace(/,/g, '');  // Remove thousands separator commas
    const amount = parseFloat(cleanedAmount) || 0;

    let status = 'pending';
    const lowerStatus = rawStatus.toLowerCase();
    if (lowerStatus.includes('completado') || lowerStatus.includes('completed') || lowerStatus.includes('pagado')) {
      status = 'paid';
    } else if (lowerStatus.includes('declinado') || lowerStatus.includes('rechazado') || 
               lowerStatus.includes('cancelado') || lowerStatus.includes('declined') ||
               lowerStatus.includes('rejected') || lowerStatus.includes('canceled') ||
               lowerStatus.includes('fallido') || lowerStatus.includes('failed')) {
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

    parsedRowsMap.set(trimmedTxId, { email: trimmedEmail, amount, status, transactionDate, transactionId: trimmedTxId, currency });
    
    // Update cache with deduplication by transaction ID
    paypalTransactionsCache.set(trimmedTxId, { email: trimmedEmail, amount, status, date: transactionDate });
  }

  const parsedRows = Array.from(parsedRowsMap.values());
  
  console.log(`[PayPal CSV] Parsed ${parsedRows.length} valid rows from CSV`);

  // Step 2: All rows will be processed (upsert mode - no skipping)
  const newRows = parsedRows;

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

  // Step 6: Prepare transactions for batch UPSERT (force update existing)
  const transactionsToUpsert = newRows.map(row => ({
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

  // Step 7: Batch UPSERT transactions (force update on conflict)
  if (transactionsToUpsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'stripe_payment_intent_id', ignoreDuplicates: false });
      
      if (error) {
        return { success: 0, errors: [`Error batch upsert transactions: ${error.message}`] };
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
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || ''
  });

  // Step 1: Parse all rows with expanded column detection
  interface ParsedWebUser {
    email: string;
    phone: string | null;
    fullName: string | null;
  }

  const parsedRows: ParsedWebUser[] = [];
  const headers = Object.keys(parsed.data[0] || {});
  console.log(`[Web Users CSV] Headers detected: ${headers.join(', ')}`);

  for (const row of parsed.data as Record<string, string>[]) {
    // Expanded email detection
    const email = row['Email']?.trim() || row['email']?.trim() || 
                  row['Correo']?.trim() || row['correo']?.trim() ||
                  row['E-mail']?.trim() || row['e-mail']?.trim() ||
                  row['Correo electrónico']?.trim() || row['correo electrónico']?.trim() ||
                  row['User Email']?.trim() || row['user_email']?.trim() || '';
    
    // Expanded phone detection
    const phone = row['Telefono']?.trim() || row['telefono']?.trim() || 
                  row['Phone']?.trim() || row['phone']?.trim() ||
                  row['Teléfono']?.trim() || row['teléfono']?.trim() ||
                  row['Tel']?.trim() || row['tel']?.trim() ||
                  row['Celular']?.trim() || row['celular']?.trim() ||
                  row['Mobile']?.trim() || row['mobile']?.trim() || null;
    
    // Expanded name detection
    const fullName = row['Nombre']?.trim() || row['nombre']?.trim() || 
                     row['Name']?.trim() || row['name']?.trim() ||
                     row['Nombre completo']?.trim() || row['nombre completo']?.trim() ||
                     row['Full Name']?.trim() || row['full_name']?.trim() ||
                     row['FullName']?.trim() || row['fullname']?.trim() ||
                     row['Usuario']?.trim() || row['usuario']?.trim() || null;

    if (!email) continue;
    parsedRows.push({ email, phone, fullName });
  }

  console.log(`[Web Users CSV] Parsed ${parsedRows.length} valid users from CSV`);

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

// ============= Subscriptions CSV Processing (NOW SAVES TO DB!) =============

export async function processSubscriptionsCSV(csvText: string): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: []
  };

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || ''
  });

  subscriptionDataCache = [];

  interface ParsedSubscription {
    email: string;
    planName: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }

  const parsedRows: ParsedSubscription[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const planName = row['Plan Name']?.trim() || row['plan_name']?.trim() || row['Plan']?.trim() || '';
    const status = row['Status']?.trim() || row['status']?.trim() || '';
    const createdAt = row['Created At (CDMX)']?.trim() || row['Created At']?.trim() || row['created_at']?.trim() || '';
    const expiresAt = row['Expires At (CDMX)']?.trim() || row['Expires At']?.trim() || row['expires_at']?.trim() || row['Expiration Date']?.trim() || '';
    const email = row['Email']?.trim() || row['email']?.trim() || row['Correo']?.trim() || '';

    if (email && planName) {
      parsedRows.push({ email, planName, status, createdAt, expiresAt });
      subscriptionDataCache.push({ email, planName, status, createdAt, expiresAt });
    }
  }

  console.log(`[Subscriptions CSV] Parsed ${parsedRows.length} valid subscriptions`);

  // Get unique emails
  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  
  // Fetch existing clients
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails.slice(0, 1000)); // Supabase limit

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Determine trial vs converted status per email
  const emailStatusMap = new Map<string, { 
    isTrial: boolean; 
    isConverted: boolean; 
    trialStarted: string | null;
    convertedAt: string | null;
    latestStatus: string;
  }>();

  const trialKeywords = ['trial', 'prueba', 'gratis', 'demo', 'free'];
  const paidKeywords = ['active', 'activo', 'paid', 'pagado', 'premium', 'pro', 'básico', 'basico'];

  for (const sub of parsedRows) {
    const planLower = sub.planName.toLowerCase();
    const statusLower = sub.status.toLowerCase();
    const isTrial = trialKeywords.some(k => planLower.includes(k));
    const isPaid = paidKeywords.some(k => planLower.includes(k) || statusLower.includes(k));

    const existing = emailStatusMap.get(sub.email) || {
      isTrial: false,
      isConverted: false,
      trialStarted: null,
      convertedAt: null,
      latestStatus: sub.status
    };

    if (isTrial) {
      existing.isTrial = true;
      existing.trialStarted = existing.trialStarted || sub.createdAt;
    }
    if (isPaid && !isTrial) {
      existing.isConverted = true;
      existing.convertedAt = existing.convertedAt || sub.createdAt;
    }
    existing.latestStatus = sub.status;
    emailStatusMap.set(sub.email, existing);
  }

  // Prepare clients for upsert
  const clientsToUpsert: Array<{
    email: string;
    status: string;
    trial_started_at: string | null;
    converted_at: string | null;
    last_sync: string;
  }> = [];

  for (const [email, data] of emailStatusMap) {
    const existingClient = clientMap.get(email);
    
    let clientStatus = existingClient?.status || 'active';
    if (data.latestStatus.toLowerCase().includes('expired') || 
        data.latestStatus.toLowerCase().includes('canceled') ||
        data.latestStatus.toLowerCase().includes('cancelled')) {
      clientStatus = 'inactive';
    }

    clientsToUpsert.push({
      email,
      status: clientStatus,
      trial_started_at: data.trialStarted ? new Date(data.trialStarted).toISOString() : existingClient?.trial_started_at || null,
      converted_at: data.isConverted && data.convertedAt ? new Date(data.convertedAt).toISOString() : existingClient?.converted_at || null,
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

  // Batch upsert clients
  if (clientsToUpsert.length > 0) {
    const batchResult = await processBatches(clientsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'email', ignoreDuplicates: false });
      
      if (error) {
        console.error('[Subscriptions CSV] Upsert error:', error);
        return { success: 0, errors: [`Error batch upsert subscriptions: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.errors.push(...batchResult.allErrors);
  }

  return result;
}

// ============= Metrics Calculation =============

export async function getMetrics(): Promise<DashboardMetrics> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Calculate first day of current month
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstDayOfMonthISO = firstDayOfMonth.toISOString();
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // ============= KPI 1: Ventas del MES (with deduplication) =============
  
  // Fetch from DB - already deduplicated by stripe_payment_intent_id
  const { data: monthTransactions } = await supabase
    .from('transactions')
    .select('id, amount, status, currency, stripe_created_at, source, stripe_payment_intent_id')
    .gte('stripe_created_at', firstDayOfMonthISO)
    .in('status', ['succeeded', 'paid']);

  // Create a Set of transaction IDs from DB to avoid double counting
  const dbTransactionIds = new Set(monthTransactions?.map(t => t.stripe_payment_intent_id) || []);

  let salesMonthUSD = 0;
  let salesMonthMXN = 0;

  for (const tx of monthTransactions || []) {
    const amountInCurrency = tx.amount / 100;
    if (tx.currency?.toLowerCase() === 'mxn') {
      salesMonthMXN += amountInCurrency;
    } else {
      salesMonthUSD += amountInCurrency;
    }
  }

  // Add PayPal from cache only if NOT already in DB (deduplicated by transaction ID)
  for (const [txId, tx] of paypalTransactionsCache) {
    const txDate = new Date(tx.date);
    
    // Only count if: this month, paid, and not already in DB
    if (txDate >= firstDayOfMonth && txDate <= today && tx.status === 'paid') {
      const paypalPaymentIntentId = `paypal_${txId}`;
      if (!dbTransactionIds.has(paypalPaymentIntentId)) {
        if (tx.amount > 500) {
          salesMonthMXN += tx.amount;
        } else {
          salesMonthUSD += tx.amount;
        }
      }
    }
  }

  const MXN_TO_USD = 0.05;
  const salesMonthTotal = salesMonthUSD + (salesMonthMXN * MXN_TO_USD);

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

  // Trial keywords: Trial, Prueba, Gratis, Demo, Free
  const trialKeywords = ['trial', 'prueba', 'gratis', 'demo', 'free'];

  // First pass: identify trial users
  for (const sub of subscriptionDataCache) {
    const planLower = sub.planName.toLowerCase();
    const isTrial = trialKeywords.some(keyword => planLower.includes(keyword));
    if (isTrial) {
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
      const isTrialPlan = trialKeywords.some(keyword => planLower.includes(keyword));
      return statusLower === 'active' && !isTrialPlan;
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
    salesMonthUSD,
    salesMonthMXN,
    salesMonthTotal,
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
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || ''
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

  // Step 2: All rows will be processed (upsert mode - no skipping)
  const newRows = parsedRows;

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

  // Step 6: Prepare transactions for batch UPSERT (force update existing)
  const transactionsToUpsert = newRows.map(row => ({
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

  // Step 7: Batch UPSERT transactions (force update on conflict)
  if (transactionsToUpsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'stripe_payment_intent_id', ignoreDuplicates: false });
      
      if (error) {
        return { success: 0, errors: [`Error batch upsert transactions: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.transactionsCreated = txBatchResult.totalSuccess;
    result.errors.push(...txBatchResult.allErrors);
  }

  return result;
}
