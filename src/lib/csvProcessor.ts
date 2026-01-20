import Papa from 'papaparse';
import { supabase } from "@/integrations/supabase/client";
import { invokeWithAdminKey } from "@/lib/adminApi";

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
  expiresAt: string;
  priceCents: number;
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

// ============= ROBUST CURRENCY PARSER (Always returns CENTS) =============

/**
 * Parses currency strings from PayPal/Stripe CSVs robustly.
 * Handles formats like: 1,234.56 (US), 1.234,56 (EU), $1,234.56, -1234.56
 * 
 * @param raw - Raw currency string from CSV
 * @param alreadyCents - If true, the value is already in cents (e.g., subscriptions.csv Price field)
 * @returns Amount in CENTS (integer) for database consistency
 */
export function parseCurrency(raw: string | number, alreadyCents: boolean = false): number {
  if (raw === null || raw === undefined) return 0;
  
  // Handle numbers directly
  if (typeof raw === 'number') {
    if (alreadyCents) return Math.round(raw);
    return Math.round(raw * 100);
  }
  
  if (typeof raw !== 'string') return 0;
  
  // Remove everything except digits, dots, commas, and minus
  let cleaned = raw.replace(/[^\d.,-]/g, '');
  
  if (!cleaned) return 0;
  
  // Handle negative
  const isNegative = cleaned.startsWith('-');
  cleaned = cleaned.replace(/-/g, '');
  
  // Determine decimal separator
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  
  let floatValue: number;
  
  if (lastDot > lastComma) {
    // US format: 1,234.56 - dot is decimal
    cleaned = cleaned.replace(/,/g, '');
    floatValue = parseFloat(cleaned);
  } else if (lastComma > lastDot) {
    // EU format: 1.234,56 - comma is decimal
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    floatValue = parseFloat(cleaned);
  } else if (lastDot === -1 && lastComma === -1) {
    // No separators: just digits
    floatValue = parseFloat(cleaned);
  } else if (lastComma !== -1 && lastDot === -1) {
    // Only comma: check if it's decimal (2 digits after) or thousands
    const afterComma = cleaned.split(',')[1];
    if (afterComma && afterComma.length === 2) {
      // Likely decimal: 123,45 -> 123.45
      cleaned = cleaned.replace(',', '.');
    } else {
      // Likely thousands: 1,234 -> 1234
      cleaned = cleaned.replace(/,/g, '');
    }
    floatValue = parseFloat(cleaned);
  } else {
    // Fallback
    cleaned = cleaned.replace(/,/g, '');
    floatValue = parseFloat(cleaned);
  }
  
  if (isNaN(floatValue)) return 0;
  
  // Apply sign and convert to cents (integer)
  const value = isNegative ? -floatValue : floatValue;
  
  // If already in cents, just round; otherwise multiply by 100
  const cents = alreadyCents ? Math.round(value) : Math.round(value * 100);
  return cents;
}

// ============= LIFECYCLE STAGE CALCULATOR =============

type LifecycleStage = 'LEAD' | 'TRIAL' | 'CUSTOMER' | 'CHURN';

interface ClientHistory {
  hasSubscription: boolean;
  hasTrialPlan: boolean;
  hasActivePaidPlan: boolean;
  hasPaidTransaction: boolean;
  hasFailedTransaction: boolean;
  hasExpiredOrCanceledSubscription: boolean;
  latestSubscriptionStatus: string | null;
}

/**
 * Calculates the lifecycle stage of a client based on their history.
 * 
 * LEAD: Exists but no payments or subscriptions
 * TRIAL: Has an active trial/free plan
 * CUSTOMER: Has at least one paid transaction
 * CHURN: Last subscription expired/canceled OR last payment failed
 */
export function calculateLifecycleStage(history: ClientHistory): LifecycleStage {
  // Priority 1: If they have paid transactions, they're a CUSTOMER
  if (history.hasPaidTransaction) {
    // Unless their latest subscription is expired/canceled (CHURN)
    if (history.hasExpiredOrCanceledSubscription && !history.hasActivePaidPlan) {
      return 'CHURN';
    }
    return 'CUSTOMER';
  }
  
  // Priority 2: Active trial = TRIAL
  if (history.hasTrialPlan) {
    return 'TRIAL';
  }
  
  // Priority 3: Has failed transactions or expired subscription = CHURN
  if (history.hasExpiredOrCanceledSubscription || history.hasFailedTransaction) {
    return 'CHURN';
  }
  
  // Priority 4: Just exists = LEAD
  return 'LEAD';
}

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

// ============= TRIAL KEYWORDS =============
const TRIAL_KEYWORDS = ['trial', 'prueba', 'gratis', 'demo', 'free'];
const PAID_KEYWORDS = ['active', 'activo', 'paid', 'pagado', 'premium', 'pro', 'básico', 'basico'];

// ============= PayPal CSV Processing =============

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
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || ''
  });

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
    const email = row['Correo electrónico del remitente'] || 
                  row['From Email Address'] || 
                  row['Correo electrónico del receptor'] ||
                  row['To Email Address'] ||
                  row['Email'] ||
                  row['email'] || '';
    
    const rawAmount = row['Bruto'] || row['Gross'] || row['Neto'] || row['Net'] || row['Amount'] || '0';
    const rawStatus = row['Estado'] || row['Status'] || '';
    const rawDate = row['Fecha y Hora'] || row['Date Time'] || row['Fecha'] || row['Date'] || '';
    const transactionId = row['Id. de transacción'] || row['Transaction ID'] || row['Id de transacción'] || '';

    if (!email || email.trim() === '') continue;
    if (!transactionId || transactionId.trim() === '') continue;
    if (email.toLowerCase().includes('total') || email.toLowerCase().includes('subtotal')) continue;

    const trimmedTxId = transactionId.trim();
    const trimmedEmail = email.trim();

    if (parsedRowsMap.has(trimmedTxId)) {
      result.transactionsSkipped++;
      continue;
    }

    // Parse amount to CENTS
    const amountCents = parseCurrency(rawAmount, false);

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

    parsedRowsMap.set(trimmedTxId, { email: trimmedEmail, amount: amountCents, status, transactionDate, transactionId: trimmedTxId, currency });
    paypalTransactionsCache.set(trimmedTxId, { email: trimmedEmail, amount: amountCents, status, date: transactionDate });
  }

  const parsedRows = Array.from(parsedRowsMap.values());
  console.log(`[PayPal CSV] Parsed ${parsedRows.length} valid rows`);

  // Get unique emails
  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails);

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Aggregate payments per email
  const emailPayments = new Map<string, { paidAmountCents: number; hasFailed: boolean; hasPaid: boolean }>();
  for (const row of parsedRows) {
    const existing = emailPayments.get(row.email) || { paidAmountCents: 0, hasFailed: false, hasPaid: false };
    if (row.status === 'paid') {
      existing.paidAmountCents += row.amount;
      existing.hasPaid = true;
    }
    if (row.status === 'failed') {
      existing.hasFailed = true;
    }
    emailPayments.set(row.email, existing);
  }

  // Prepare clients for upsert with lifecycle_stage
  const clientsToUpsert: Array<{
    email: string;
    payment_status: string;
    total_paid: number;
    status: string;
    lifecycle_stage: LifecycleStage;
    last_sync: string;
  }> = [];

  for (const [email, payments] of emailPayments) {
    const existingClient = clientMap.get(email);
    const newTotalPaid = (existingClient?.total_paid || 0) + (payments.paidAmountCents / 100);
    
    let paymentStatus = existingClient?.payment_status || 'none';
    if (payments.hasPaid) {
      paymentStatus = 'paid';
    } else if (payments.hasFailed && paymentStatus !== 'paid') {
      paymentStatus = 'failed';
    }

    // Calculate lifecycle stage
    const history: ClientHistory = {
      hasSubscription: false,
      hasTrialPlan: false,
      hasActivePaidPlan: false,
      hasPaidTransaction: payments.hasPaid || (existingClient?.payment_status === 'paid'),
      hasFailedTransaction: payments.hasFailed,
      hasExpiredOrCanceledSubscription: false,
      latestSubscriptionStatus: null
    };
    
    const lifecycle = calculateLifecycleStage(history);

    clientsToUpsert.push({
      email,
      payment_status: paymentStatus,
      total_paid: newTotalPaid,
      status: existingClient?.status || 'active',
      lifecycle_stage: lifecycle,
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

  // NORMALIZED DEDUPLICATION using payment_key + source
  // PayPal: transaction_id is the canonical payment_key
  const transactionsToUpsert = parsedRows.map(row => ({
    customer_email: row.email,
    amount: row.amount, // Already in cents
    status: row.status,
    source: 'paypal',
    payment_key: row.transactionId, // CANONICAL dedup key (NO prefix)
    external_transaction_id: row.transactionId, // CLEAN ID for reference
    stripe_payment_intent_id: `paypal_${row.transactionId}`, // Backwards compat
    stripe_created_at: row.transactionDate.toISOString(),
    currency: row.currency.toLowerCase(), // Normalize to lowercase
    failure_code: row.status === 'failed' ? 'payment_failed' : null,
    failure_message: row.status === 'failed' ? 'Pago rechazado por PayPal' : null
  }));

  if (transactionsToUpsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToUpsert, BATCH_SIZE, async (batch) => {
      // Use new UNIQUE constraint: (source, payment_key)
      const { error } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'source,payment_key', ignoreDuplicates: false });
      
      if (error) {
        return { success: 0, errors: [`Error batch upsert transactions: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.transactionsCreated = txBatchResult.totalSuccess;
    result.errors.push(...txBatchResult.allErrors);
  }

  // 🔔 TRIGGER: Notify GHL for failed PayPal payments (OPTIONAL - silent fail)
  const failedPayments = parsedRows.filter(row => row.status === 'failed');
  
  if (failedPayments.length > 0) {
    console.log(`[GHL] ${failedPayments.length} pagos fallidos detectados. Notificación GHL es opcional.`);
    
    // Run GHL notifications in background - don't block import
    (async () => {
      for (const payment of failedPayments.slice(0, 20)) {
        try {
          const client = clientMap.get(payment.email);
          await invokeWithAdminKey('notify-ghl', {
            email: payment.email,
            phone: client?.phone || null,
            name: client?.full_name || null,
            tag: 'payment_failed',
            message_data: {
              amount_cents: payment.amount,
              currency: payment.currency,
              transaction_id: payment.transactionId,
              source: 'paypal_csv'
            }
          });
        } catch {
          // GHL not configured - silently ignore
        }
      }
    })().catch(() => {
      // Silently ignore all GHL errors
      console.log('[GHL] Notificaciones deshabilitadas o no configuradas');
    });
  }

  return result;
}

// ============= Web Users CSV Processing =============

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

  interface ParsedWebUser {
    email: string;
    phone: string | null;
    fullName: string | null;
  }

  const parsedRows: ParsedWebUser[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['Email']?.trim() || row['email']?.trim() || 
                  row['Correo']?.trim() || row['correo']?.trim() ||
                  row['E-mail']?.trim() || row['e-mail']?.trim() ||
                  row['Correo electrónico']?.trim() || row['correo electrónico']?.trim() ||
                  row['User Email']?.trim() || row['user_email']?.trim() || '';
    
    const phone = row['Telefono']?.trim() || row['telefono']?.trim() || 
                  row['Phone']?.trim() || row['phone']?.trim() ||
                  row['Teléfono']?.trim() || row['teléfono']?.trim() ||
                  row['Tel']?.trim() || row['tel']?.trim() ||
                  row['Celular']?.trim() || row['celular']?.trim() ||
                  row['Mobile']?.trim() || row['mobile']?.trim() || null;
    
    const fullName = row['Nombre']?.trim() || row['nombre']?.trim() || 
                     row['Name']?.trim() || row['name']?.trim() ||
                     row['Nombre completo']?.trim() || row['nombre completo']?.trim() ||
                     row['Full Name']?.trim() || row['full_name']?.trim() ||
                     row['FullName']?.trim() || row['fullname']?.trim() ||
                     row['Usuario']?.trim() || row['usuario']?.trim() || null;

    if (!email) continue;
    parsedRows.push({ email, phone, fullName });
  }

  console.log(`[Web Users CSV] Parsed ${parsedRows.length} valid users`);

  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails);

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Merge data from multiple rows with same email
  const emailDataMap = new Map<string, ParsedWebUser>();
  for (const row of parsedRows) {
    const existing = emailDataMap.get(row.email);
    if (existing) {
      emailDataMap.set(row.email, {
        email: row.email,
        phone: row.phone || existing.phone,
        fullName: row.fullName || existing.fullName
      });
    } else {
      emailDataMap.set(row.email, row);
    }
  }

  // All users from web CSV without payments are LEADs
  const clientsToUpsert: Array<{
    email: string;
    phone: string | null;
    full_name: string | null;
    status: string;
    lifecycle_stage: LifecycleStage;
    last_sync: string;
  }> = [];

  for (const [email, data] of emailDataMap) {
    const existingClient = clientMap.get(email);
    
    // Keep existing lifecycle_stage if already set to something other than LEAD
    const currentStage = existingClient?.lifecycle_stage as LifecycleStage | null;
    const lifecycle: LifecycleStage = currentStage && currentStage !== 'LEAD' ? currentStage : 'LEAD';
    
    clientsToUpsert.push({
      email,
      phone: data.phone || existingClient?.phone || null,
      full_name: data.fullName || existingClient?.full_name || null,
      status: existingClient?.status || 'active',
      lifecycle_stage: lifecycle,
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

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

  // 🔔 TRIGGER: Notify GHL for new leads (users without payments)
  const newLeads = Array.from(emailDataMap.values())
    .filter(row => !clientMap.has(row.email)); // Only new users

  if (newLeads.length > 0) {
    console.log(`[GHL] Sending ${newLeads.length} new leads to CRM...`);
    
    // Send notifications in background (non-blocking)
    for (const lead of newLeads.slice(0, 50)) { // Limit to 50 per batch
      try {
        await supabase.functions.invoke('notify-ghl', {
          body: {
            email: lead.email,
            phone: lead.phone,
            name: lead.fullName,
            tag: 'new_lead',
            message_data: {
              source: 'csv_import',
              imported_at: new Date().toISOString()
            }
          }
        });
      } catch (ghlError) {
        console.warn(`[GHL] Failed to notify for ${lead.email}:`, ghlError);
      }
    }
    console.log(`[GHL] New lead notifications sent`);
  }

  return result;
}

// ============= Subscriptions CSV Processing =============

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
    priceCents: number;
  }

  const parsedRows: ParsedSubscription[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    const planName = row['Plan Name']?.trim() || row['plan_name']?.trim() || row['Plan']?.trim() || '';
    const status = row['Status']?.trim() || row['status']?.trim() || '';
    const createdAt = row['Created At (CDMX)']?.trim() || row['Created At']?.trim() || row['created_at']?.trim() || '';
    const expiresAt = row['Expires At (CDMX)']?.trim() || row['Expires At']?.trim() || row['expires_at']?.trim() || row['Expiration Date']?.trim() || '';
    const email = row['Email']?.trim() || row['email']?.trim() || row['Correo']?.trim() || '';
    
    // Price field - subscriptions.csv typically has Price in CENTS already
    const rawPrice = row['Price']?.trim() || row['price']?.trim() || row['Amount']?.trim() || '0';
    const priceCents = parseCurrency(rawPrice, true); // Already in cents

    if (email && planName) {
      parsedRows.push({ email, planName, status, createdAt, expiresAt, priceCents });
      subscriptionDataCache.push({ email, planName, status, createdAt, expiresAt, priceCents });
    }
  }

  console.log(`[Subscriptions CSV] Parsed ${parsedRows.length} valid subscriptions`);

  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails.slice(0, 1000));

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Fetch existing transactions to check for paid status
  const { data: existingTransactions } = await supabase
    .from('transactions')
    .select('customer_email, status')
    .in('customer_email', uniqueEmails.slice(0, 1000))
    .in('status', ['succeeded', 'paid']);

  const paidEmails = new Set(existingTransactions?.map(t => t.customer_email) || []);

  // Analyze subscription status per email
  const emailStatusMap = new Map<string, { 
    isTrial: boolean; 
    isActivePaid: boolean;
    isExpiredOrCanceled: boolean;
    trialStarted: string | null;
    convertedAt: string | null;
    latestStatus: string;
    hasPaid: boolean;
  }>();

  for (const sub of parsedRows) {
    const planLower = sub.planName.toLowerCase();
    const statusLower = sub.status.toLowerCase();
    
    const isTrial = TRIAL_KEYWORDS.some(k => planLower.includes(k));
    const isPaidPlan = !isTrial && (
      PAID_KEYWORDS.some(k => planLower.includes(k)) || 
      sub.priceCents > 0
    );
    const isActive = statusLower === 'active' || statusLower === 'activo';
    const isExpiredOrCanceled = statusLower === 'expired' || statusLower === 'canceled' || 
                                 statusLower === 'cancelled' || statusLower === 'pastdue';

    const existing = emailStatusMap.get(sub.email) || {
      isTrial: false,
      isActivePaid: false,
      isExpiredOrCanceled: false,
      trialStarted: null,
      convertedAt: null,
      latestStatus: sub.status,
      hasPaid: paidEmails.has(sub.email)
    };

    if (isTrial && isActive) {
      existing.isTrial = true;
      existing.trialStarted = existing.trialStarted || sub.createdAt;
    }
    if (isPaidPlan && isActive) {
      existing.isActivePaid = true;
      existing.convertedAt = existing.convertedAt || sub.createdAt;
    }
    if (isExpiredOrCanceled) {
      existing.isExpiredOrCanceled = true;
    }
    existing.latestStatus = sub.status;
    emailStatusMap.set(sub.email, existing);
  }

  // Prepare clients for upsert with lifecycle_stage
  const clientsToUpsert: Array<{
    email: string;
    status: string;
    lifecycle_stage: LifecycleStage;
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

    // Calculate lifecycle stage using the function
    const history: ClientHistory = {
      hasSubscription: true,
      hasTrialPlan: data.isTrial,
      hasActivePaidPlan: data.isActivePaid,
      hasPaidTransaction: data.hasPaid,
      hasFailedTransaction: false,
      hasExpiredOrCanceledSubscription: data.isExpiredOrCanceled && !data.isActivePaid,
      latestSubscriptionStatus: data.latestStatus
    };
    
    const lifecycle = calculateLifecycleStage(history);

    clientsToUpsert.push({
      email,
      status: clientStatus,
      lifecycle_stage: lifecycle,
      trial_started_at: data.trialStarted ? new Date(data.trialStarted).toISOString() : existingClient?.trial_started_at || null,
      converted_at: data.isActivePaid && data.convertedAt ? new Date(data.convertedAt).toISOString() : existingClient?.converted_at || null,
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

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

// ============= Stripe CSV Processing =============

export async function processPaymentCSV(
  csvText: string, 
  source: 'stripe' | 'paypal'
): Promise<ProcessingResult> {
  if (source === 'paypal') {
    return processPayPalCSV(csvText);
  }
  
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

  interface ParsedStripeRow {
    email: string;
    chargeId: string;
    paymentIntentId: string;
    amount: number;
    status: string;
    date: string;
  }

  const parsedRowsMap = new Map<string, ParsedStripeRow>();

  for (const row of parsed.data as Record<string, string>[]) {
    // CRITICAL FIX #1: Map "Customer Email" column explicitly
    const email = row['Customer Email']?.trim() || 
                  row['Customer email']?.trim() || 
                  row['customer_email']?.trim() ||
                  row['Email']?.trim() || 
                  row['email']?.trim() || '';
    
    // CRITICAL FIX #3: Handle IDs - Charge ID (ch_) and PaymentIntent ID (pi_)
    const chargeId = row['id']?.trim() || row['ID']?.trim() || row['Charge ID']?.trim() || '';
    const paymentIntentId = row['PaymentIntent ID']?.trim() || 
                            row['payment_intent']?.trim() || 
                            row['Payment Intent']?.trim() || '';
    
    // Rule: If PaymentIntent ID exists, use it as primary key; else use Charge ID
    const finalStripeId = paymentIntentId || chargeId;
    
    if (!email || !finalStripeId) continue;

    const rawAmount = row['Amount']?.trim() || row['amount']?.trim() || '0';
    
    // CRITICAL FIX #2: Normalize status to lowercase
    const rawStatus = (row['Status'] || row['status'] || '').toString().toLowerCase();
    let status = 'pending';
    if (rawStatus === 'paid' || rawStatus === 'succeeded') {
      status = 'paid';
    } else if (rawStatus === 'failed' || rawStatus === 'requires_payment_method') {
      status = 'failed';
    }
    
    const date = row['Created date (UTC)']?.trim() || row['created']?.trim() || 
                 row['Date']?.trim() || row['date']?.trim() || new Date().toISOString();

    if (parsedRowsMap.has(finalStripeId)) {
      result.transactionsSkipped++;
      continue;
    }

    // CRITICAL FIX: Stripe CSV amounts are in DOLLARS (19.50) -> multiply by 100
    const amountCents = parseCurrency(rawAmount, false);
    
    parsedRowsMap.set(finalStripeId, { 
      email, 
      chargeId,
      paymentIntentId: finalStripeId, 
      amount: amountCents, 
      status, 
      date 
    });
  }

  const parsedRows = Array.from(parsedRowsMap.values());
  console.log(`[Stripe CSV] Parsed ${parsedRows.length} valid rows`);

  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails);

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Aggregate payments per email
  const emailPayments = new Map<string, { paidAmountCents: number; hasFailed: boolean; hasPaid: boolean }>();
  for (const row of parsedRows) {
    const existing = emailPayments.get(row.email) || { paidAmountCents: 0, hasFailed: false, hasPaid: false };
    const isPaid = row.status === 'paid';
    if (isPaid) {
      existing.paidAmountCents += row.amount;
      existing.hasPaid = true;
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
    lifecycle_stage: LifecycleStage;
    last_sync: string;
  }> = [];

  for (const [email, payments] of emailPayments) {
    const existingClient = clientMap.get(email);
    const newTotalPaid = (existingClient?.total_paid || 0) + (payments.paidAmountCents / 100);
    
    let paymentStatus = existingClient?.payment_status || 'none';
    if (payments.hasPaid) {
      paymentStatus = 'paid';
    } else if (payments.hasFailed && paymentStatus !== 'paid') {
      paymentStatus = 'failed';
    }

    const history: ClientHistory = {
      hasSubscription: false,
      hasTrialPlan: false,
      hasActivePaidPlan: false,
      hasPaidTransaction: payments.hasPaid || (existingClient?.payment_status === 'paid'),
      hasFailedTransaction: payments.hasFailed,
      hasExpiredOrCanceledSubscription: false,
      latestSubscriptionStatus: null
    };
    
    const lifecycle = calculateLifecycleStage(history);

    clientsToUpsert.push({
      email,
      payment_status: paymentStatus,
      total_paid: newTotalPaid,
      status: existingClient?.status || 'active',
      lifecycle_stage: lifecycle,
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

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

  // NORMALIZED DEDUPLICATION using payment_key + source
  // Stripe CSV: use payment_intent_id if exists, else charge_id
  const transactionsToUpsert = parsedRows.map(row => {
    // payment_key: PaymentIntent takes priority over Charge ID
    const paymentKey = row.paymentIntentId || row.chargeId;
    
    return {
      customer_email: row.email,
      amount: row.amount, // Already in cents
      status: row.status, // Already normalized to lowercase
      source: 'stripe',
      payment_key: paymentKey, // CANONICAL dedup key
      external_transaction_id: row.chargeId || null, // Original Charge ID
      stripe_payment_intent_id: row.paymentIntentId || row.chargeId, // For backwards compat
      stripe_created_at: new Date(row.date).toISOString(),
      currency: 'usd',
      failure_code: row.status === 'failed' ? 'payment_failed' : null,
      failure_message: row.status === 'failed' ? 'Pago fallido' : null
    };
  });

  if (transactionsToUpsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToUpsert, BATCH_SIZE, async (batch) => {
      // Use new UNIQUE constraint: (source, payment_key)
      const { error } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'source,payment_key', ignoreDuplicates: false });
      
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

// ============= Legacy function =============

export async function processWebCSV(csvText: string): Promise<ProcessingResult> {
  return processWebUsersCSV(csvText);
}

// ============= Stripe Unified Customers CSV Processing (LTV Master Data) =============

export interface StripeCustomerResult extends ProcessingResult {
  duplicatesResolved: number;
  totalLTV: number;
  delinquentCount: number;
}

/**
 * Processes unified_customers.csv from Stripe.
 * This file contains customer data with Total Spend (LTV) and Delinquent status.
 * 
 * DEDUPLICATION LOGIC:
 * - Multiple rows can exist for the same email
 * - We group by normalized email (lowercase, trimmed)
 * - Select the "canonical" customer: the one with the highest Total Spend
 * - Use that customer's stripe_customer_id and total_spend as the source of truth
 */
export async function processStripeCustomersCSV(csvText: string): Promise<StripeCustomerResult> {
  const result: StripeCustomerResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: [],
    duplicatesResolved: 0,
    totalLTV: 0,
    delinquentCount: 0
  };

  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || ''
  });

  interface StripeCustomerRow {
    email: string;
    stripeCustomerId: string;
    name: string | null;
    totalSpend: number; // in cents
    isDelinquent: boolean;
    metadata: Record<string, string>;
    created: string | null;
  }

  // Parse all rows
  const allRows: StripeCustomerRow[] = [];

  for (const row of parsed.data as Record<string, string>[]) {
    // Flexible column mapping for Stripe exports
    const email = (
      row['Email'] || row['email'] || 
      row['Customer Email'] || row['customer_email'] ||
      ''
    ).toLowerCase().trim();

    const stripeCustomerId = 
      row['Customer ID'] || row['customer_id'] || 
      row['ID'] || row['id'] ||
      row['Stripe Customer ID'] || '';

    const name = 
      row['Name'] || row['name'] || 
      row['Customer Name'] || row['customer_name'] || null;

    // Total Spend - check if it's in cents or dollars
    const rawTotalSpend = row['Total Spend'] || row['total_spend'] || 
                          row['Total Amount'] || row['Lifetime Value'] || 
                          row['LTV'] || '0';
    
    // Stripe exports Total Spend in dollars, convert to cents
    const totalSpendCents = parseCurrency(rawTotalSpend, false);

    // Delinquent status
    const rawDelinquent = row['Delinquent'] || row['delinquent'] || 
                          row['Is Delinquent'] || row['is_delinquent'] || 'false';
    const isDelinquent = rawDelinquent.toLowerCase() === 'true' || rawDelinquent === '1';

    // Created date
    const created = row['Created'] || row['created'] || 
                    row['Created (UTC)'] || row['Created Date'] || null;

    // Extract metadata columns (funnel data, etc.)
    const metadata: Record<string, string> = {};
    const metadataKeys = ['Funnel', 'Source', 'Campaign', 'UTM Source', 'UTM Medium', 'UTM Campaign'];
    for (const key of metadataKeys) {
      if (row[key] && row[key].trim()) {
        metadata[key.toLowerCase().replace(/\s+/g, '_')] = row[key].trim();
      }
    }

    if (!email || !stripeCustomerId) continue;

    allRows.push({
      email,
      stripeCustomerId: stripeCustomerId.trim(),
      name: name?.trim() || null,
      totalSpend: totalSpendCents,
      isDelinquent,
      metadata,
      created
    });
  }

  console.log(`[Stripe Customers CSV] Parsed ${allRows.length} customer rows`);

  // GROUP BY EMAIL and select canonical customer (highest Total Spend)
  const emailGroups = new Map<string, StripeCustomerRow[]>();
  
  for (const row of allRows) {
    const existing = emailGroups.get(row.email) || [];
    existing.push(row);
    emailGroups.set(row.email, existing);
  }

  // Track duplicates
  let duplicateEmailsFound = 0;
  for (const [_email, rows] of emailGroups) {
    if (rows.length > 1) {
      duplicateEmailsFound++;
      result.duplicatesResolved += rows.length - 1; // We keep 1, discard the rest
    }
  }
  
  console.log(`[Stripe Customers CSV] Found ${duplicateEmailsFound} emails with duplicates, resolving ${result.duplicatesResolved} duplicate entries`);

  // Select canonical customer per email
  const canonicalCustomers: StripeCustomerRow[] = [];
  
  for (const [_email, rows] of emailGroups) {
    // Sort by totalSpend descending, take the highest
    rows.sort((a, b) => b.totalSpend - a.totalSpend);
    const canonical = rows[0];
    
    // Merge metadata from all rows (in case different rows have different metadata)
    const mergedMetadata = { ...canonical.metadata };
    for (const row of rows.slice(1)) {
      for (const [key, value] of Object.entries(row.metadata)) {
        if (!mergedMetadata[key] && value) {
          mergedMetadata[key] = value;
        }
      }
    }
    
    canonicalCustomers.push({
      ...canonical,
      metadata: mergedMetadata
    });
  }

  console.log(`[Stripe Customers CSV] ${canonicalCustomers.length} canonical customers after deduplication`);

  // Get existing clients from DB
  const uniqueEmails = canonicalCustomers.map(c => c.email);
  const { data: existingClients } = await supabase
    .from('clients')
    .select('*')
    .in('email', uniqueEmails.slice(0, 1000));

  const clientMap = new Map(existingClients?.map(c => [c.email, c]) || []);

  // Prepare upsert batch
  const clientsToUpsert: Array<{
    email: string;
    full_name: string | null;
    stripe_customer_id: string;
    total_spend: number;
    is_delinquent: boolean;
    customer_metadata: Record<string, string>;
    lifecycle_stage: LifecycleStage;
    last_sync: string;
  }> = [];

  for (const customer of canonicalCustomers) {
    const existingClient = clientMap.get(customer.email);
    
    // Determine lifecycle stage based on spend and delinquent status
    let lifecycle: LifecycleStage = 'LEAD';
    
    if (customer.totalSpend > 0) {
      lifecycle = 'CUSTOMER';
    }
    
    // Keep existing lifecycle if it's already CUSTOMER or TRIAL (don't demote)
    const currentStage = existingClient?.lifecycle_stage as LifecycleStage | null;
    if (currentStage === 'CUSTOMER' || (currentStage === 'TRIAL' && lifecycle !== 'CUSTOMER')) {
      lifecycle = currentStage;
    }

    // If delinquent and was customer, mark as CHURN
    if (customer.isDelinquent && lifecycle === 'CUSTOMER') {
      lifecycle = 'CHURN';
    }

    result.totalLTV += customer.totalSpend;
    if (customer.isDelinquent) {
      result.delinquentCount++;
    }

    clientsToUpsert.push({
      email: customer.email,
      full_name: customer.name || existingClient?.full_name || null,
      stripe_customer_id: customer.stripeCustomerId,
      total_spend: customer.totalSpend, // Already in cents
      is_delinquent: customer.isDelinquent,
      customer_metadata: customer.metadata,
      lifecycle_stage: lifecycle,
      last_sync: new Date().toISOString()
    });

    if (existingClient) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

  // Batch upsert
  if (clientsToUpsert.length > 0) {
    const batchResult = await processBatches(clientsToUpsert, BATCH_SIZE, async (batch) => {
      const { error } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'email', ignoreDuplicates: false });
      
      if (error) {
        console.error('[Stripe Customers CSV] Upsert error:', error);
        return { success: 0, errors: [`Error batch upsert customers: ${error.message}`] };
      }
      return { success: batch.length, errors: [] };
    });
    result.errors.push(...batchResult.allErrors);
  }

  console.log(`[Stripe Customers CSV] Complete: ${result.clientsCreated} created, ${result.clientsUpdated} updated, ${result.duplicatesResolved} duplicates resolved`);
  console.log(`[Stripe Customers CSV] Total LTV: $${(result.totalLTV / 100).toFixed(2)}, Delinquent: ${result.delinquentCount}`);

  return result;
}

// ============= Metrics Calculation =============

export async function getMetrics(): Promise<DashboardMetrics> {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstDayOfMonthISO = firstDayOfMonth.toISOString();
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // ============= KPI 1: Monthly Sales (ONLY paid status, amounts in cents) =============
  
  const { data: monthTransactions } = await supabase
    .from('transactions')
    .select('id, amount, status, currency, stripe_created_at, source, stripe_payment_intent_id')
    .gte('stripe_created_at', firstDayOfMonthISO)
    .in('status', ['succeeded', 'paid']); // ONLY count paid transactions

  const dbTransactionIds = new Set(monthTransactions?.map(t => t.stripe_payment_intent_id) || []);

  let salesMonthUSD = 0;
  let salesMonthMXN = 0;

  for (const tx of monthTransactions || []) {
    // All amounts stored in CENTS, divide by 100 for display
    const amountInCurrency = tx.amount / 100;
    if (tx.currency?.toLowerCase() === 'mxn') {
      salesMonthMXN += amountInCurrency;
    } else {
      salesMonthUSD += amountInCurrency;
    }
  }

  // Add PayPal from cache only if NOT already in DB
  for (const [txId, tx] of paypalTransactionsCache) {
    const txDate = new Date(tx.date);
    
    if (txDate >= firstDayOfMonth && txDate <= today && tx.status === 'paid') {
      const paypalPaymentIntentId = `paypal_${txId}`;
      if (!dbTransactionIds.has(paypalPaymentIntentId)) {
        const amountInCurrency = tx.amount / 100; // Cache is also in cents
        if (tx.amount > 50000) { // 500 USD threshold for MXN
          salesMonthMXN += amountInCurrency;
        } else {
          salesMonthUSD += amountInCurrency;
        }
      }
    }
  }

  const MXN_TO_USD = 0.05;
  const salesMonthTotal = salesMonthUSD + (salesMonthMXN * MXN_TO_USD);

  // ============= KPI 2: Conversion Rate (UNIQUE emails) =============
  
  const emailSubscriptions = new Map<string, SubscriptionData[]>();
  for (const sub of subscriptionDataCache) {
    if (!sub.email) continue;
    const existing = emailSubscriptions.get(sub.email) || [];
    existing.push(sub);
    emailSubscriptions.set(sub.email, existing);
  }

  const trialEmails = new Set<string>();
  const convertedEmails = new Set<string>();

  // First pass: identify UNIQUE trial emails
  for (const sub of subscriptionDataCache) {
    if (!sub.email) continue;
    const planLower = sub.planName.toLowerCase();
    const isTrial = TRIAL_KEYWORDS.some(keyword => planLower.includes(keyword));
    if (isTrial) {
      trialEmails.add(sub.email);
    }
  }

  // Second pass: count conversions
  for (const email of trialEmails) {
    const subs = emailSubscriptions.get(email) || [];
    const hasActivePaidPlan = subs.some(sub => {
      const statusLower = sub.status.toLowerCase();
      const planLower = sub.planName.toLowerCase();
      const isTrialPlan = TRIAL_KEYWORDS.some(keyword => planLower.includes(keyword));
      return (statusLower === 'active' || statusLower === 'activo') && !isTrialPlan;
    });
    if (hasActivePaidPlan) {
      convertedEmails.add(email);
    }
  }

  const trialCount = trialEmails.size;
  const convertedCount = convertedEmails.size;
  const conversionRate = trialCount > 0 ? (convertedCount / trialCount) * 100 : 0;

  // ============= KPI 3: Churn (UNIQUE EMAILS) =============
  // CRITICAL FIX #3: Count unique emails, not rows
  // A user is churned if their LAST subscription is expired/canceled AND no subsequent paid transactions
  
  const churnedEmails = new Set<string>();
  
  // Group subscriptions by email and find latest status
  const emailLatestSub = new Map<string, { status: string; expiresAt: string }>();
  
  for (const sub of subscriptionDataCache) {
    if (!sub.email) continue;
    const existing = emailLatestSub.get(sub.email);
    
    // Keep the latest subscription by expires date
    if (!existing || (sub.expiresAt && new Date(sub.expiresAt) > new Date(existing.expiresAt))) {
      emailLatestSub.set(sub.email, { status: sub.status, expiresAt: sub.expiresAt });
    }
  }
  
  // Check which emails have churned (last sub expired/canceled, no recent paid)
  for (const [email, latestSub] of emailLatestSub) {
    const statusLower = latestSub.status.toLowerCase();
    
    if (statusLower === 'expired' || statusLower === 'canceled' || statusLower === 'pastdue') {
      if (latestSub.expiresAt) {
        const expiresDate = new Date(latestSub.expiresAt);
        if (!isNaN(expiresDate.getTime()) && expiresDate >= thirtyDaysAgo && expiresDate <= today) {
          // Check if they have any paid transactions after expiry
          const hasPaidAfterExpiry = convertedEmails.has(email);
          if (!hasPaidAfterExpiry) {
            churnedEmails.add(email);
          }
        }
      }
    }
  }
  
  const churnCount = churnedEmails.size;

  // ============= Recovery List =============
  
  const { data: failedTransactions } = await supabase
    .from('transactions')
    .select('customer_email, amount, source, status, failure_code')
    .in('status', ['failed', 'canceled']);

  const { data: pendingPaymentTransactions } = await supabase
    .from('transactions')
    .select('customer_email, amount, source, status, failure_code')
    .in('failure_code', ['requires_payment_method', 'requires_action', 'requires_confirmation']);

  const allFailedTransactions = [
    ...(failedTransactions || []),
    ...(pendingPaymentTransactions || [])
  ];

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
      failedAmounts[tx.customer_email].amount += tx.amount / 100; // Convert cents to dollars
    }
  }

  for (const tx of failedPayPal) {
    allFailedEmails.add(tx.email);
    if (!failedAmounts[tx.email]) {
      failedAmounts[tx.email] = { amount: 0, source: 'paypal' };
    } else {
      failedAmounts[tx.email].source = 'stripe/paypal';
    }
    failedAmounts[tx.email].amount += tx.amount / 100; // Convert cents to dollars
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
