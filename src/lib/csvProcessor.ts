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

// ============= BOM & HEADER NORMALIZATION =============

/**
 * Strips BOM (Byte Order Mark) from CSV content and normalizes headers.
 * This ensures compatibility with files exported from Excel, Google Sheets, etc.
 * 
 * Handles:
 * - UTF-8 BOM (\uFEFF)
 * - Trailing/leading quotes on headers
 * - Extra whitespace
 */
export function normalizeCSV(csvText: string): string {
  // Strip UTF-8 BOM if present
  let normalized = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  
  // Normalize line endings to \n
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Get first line (headers) and normalize it
  const lines = normalized.split('\n');
  if (lines.length > 0) {
    // Normalize header line: trim, remove dangling quotes, normalize whitespace
    const headerLine = lines[0];
    const normalizedHeader = headerLine
      .split(',')
      .map(h => {
        // Remove leading/trailing whitespace and quotes
        let cleaned = h.trim();
        // Remove surrounding quotes if they exist
        if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || 
            (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
          cleaned = cleaned.slice(1, -1).trim();
        }
        // Remove any remaining quotes at start/end
        cleaned = cleaned.replace(/^["']+|["']+$/g, '').trim();
        return cleaned;
      })
      .join(',');
    
    lines[0] = normalizedHeader;
    normalized = lines.join('\n');
  }
  
  return normalized;
}

/**
 * Parses CSV with BOM stripping and header normalization.
 * Use this instead of raw Papa.parse for all CSV imports.
 */
export function parseCSVSafe(csvText: string): Papa.ParseResult<Record<string, string>> {
  const normalizedText = normalizeCSV(csvText);
  
  return Papa.parse(normalizedText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value?.trim() || ''
  });
}

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

// ============= CATCH-ALL: Capture unmapped columns into raw_data =============

/**
 * Known columns that are already mapped - anything else goes to raw_data.
 * This ensures we NEVER lose information from CSV imports.
 */
const KNOWN_PAYPAL_COLUMNS = new Set([
  'correo electrónico del remitente', 'from email address', 'correo electrónico del receptor',
  'to email address', 'email', 'bruto', 'gross', 'neto', 'net', 'amount',
  'estado', 'status', 'fecha y hora', 'date time', 'fecha', 'date',
  'id. de transacción', 'transaction id', 'id de transacción'
].map(c => c.toLowerCase()));

const KNOWN_STRIPE_COLUMNS = new Set([
  'customer email', 'customer_email', 'email', 'id', 'charge id', 
  'paymentintent id', 'payment_intent', 'payment intent', 'amount',
  'status', 'created date (utc)', 'created', 'date'
].map(c => c.toLowerCase()));

const KNOWN_GHL_COLUMNS = new Set([
  'id', 'contact id', 'contactid', 'email', 'email address', 'emailaddress',
  'phone', 'mobile', 'phonenumber', 'phone number', 'firstname', 'first name',
  'first_name', 'lastname', 'last name', 'last_name', 'name', 'full name',
  'fullname', 'tags', 'tag', 'source', 'lead source', 'leadsource',
  'datecreated', 'date created', 'createdat', 'created at', 'dndsettings', 'dnd'
].map(c => c.toLowerCase()));

/**
 * Extracts all unmapped columns into a raw_data object.
 * This is the CATCH-ALL to never lose data from CSV imports.
 */
function extractRawData(
  row: Record<string, string>, 
  knownColumns: Set<string>
): Record<string, string> {
  const rawData: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(row)) {
    const keyLower = key.toLowerCase().trim();
    // If column is not in known list and has a value, capture it
    if (!knownColumns.has(keyLower) && value && value.trim()) {
      rawData[key] = value.trim();
    }
  }
  
  return rawData;
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

  // Use safe parser with BOM stripping and header normalization
  const parsed = parseCSVSafe(csvText);

  interface ParsedPayPalRow {
    email: string;
    amount: number;
    status: string;
    transactionDate: Date;
    transactionId: string;
    currency: string;
    rawData: Record<string, string>; // CATCH-ALL for unmapped columns
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

    // CATCH-ALL: Capture all unmapped columns
    const rawData = extractRawData(row, KNOWN_PAYPAL_COLUMNS);

    parsedRowsMap.set(trimmedTxId, { 
      email: trimmedEmail, 
      amount: amountCents, 
      status, 
      transactionDate, 
      transactionId: trimmedTxId, 
      currency,
      rawData // Store extra columns
    });
    paypalTransactionsCache.set(trimmedTxId, { email: trimmedEmail, amount: amountCents, status, date: transactionDate });
  }

  const parsedRows = Array.from(parsedRowsMap.values());
  console.log(`[PayPal CSV] Parsed ${parsedRows.length} valid rows`);
  console.log(`[PayPal CSV] Sample raw_data keys: ${parsedRows[0]?.rawData ? Object.keys(parsedRows[0].rawData).slice(0, 5).join(', ') : 'none'}`);

  // Get unique emails - load in batches to avoid Supabase 1000 param limit
  const uniqueEmails = [...new Set(parsedRows.map(r => r.email))];
  const clientMap = new Map<string, any>();
  const EMAIL_BATCH_SIZE = 500;
  
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('*')
      .in('email', emailBatch);
    
    existingClients?.forEach(c => clientMap.set(c.email, c));
  }
  
  console.log(`[PayPal CSV] Loaded ${clientMap.size} existing clients from DB`);

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
    failure_message: row.status === 'failed' ? 'Pago rechazado por PayPal' : null,
    // CATCH-ALL: Store extra columns in metadata
    metadata: Object.keys(row.rawData).length > 0 ? { csv_raw: row.rawData } : null
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

  // Use safe parser with BOM stripping and header normalization
  const parsed = parseCSVSafe(csvText);

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
  
  // Load existing clients in batches to avoid Supabase 1000 param limit
  const clientMap = new Map<string, any>();
  const EMAIL_BATCH_SIZE = 500;
  
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('*')
      .in('email', emailBatch);
    
    existingClients?.forEach(c => clientMap.set(c.email, c));
  }
  
  console.log(`[Web Users CSV] Loaded ${clientMap.size} existing clients from DB`);

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

  // 🔔 TRIGGER: Notify GHL for new leads (OPTIONAL - silent fail, non-blocking)
  const newLeads = Array.from(emailDataMap.values())
    .filter(row => !clientMap.has(row.email));

  if (newLeads.length > 0) {
    console.log(`[GHL] ${newLeads.length} nuevos leads detectados. Notificación GHL es opcional.`);
    
    // Run in background - NEVER block CSV import
    (async () => {
      for (const lead of newLeads.slice(0, 50)) {
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
        } catch {
          // GHL not configured - silently ignore
        }
      }
    })().catch(() => {
      console.log('[GHL] Notificaciones de leads deshabilitadas');
    });
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

  // Use safe parser with BOM stripping and header normalization
  const parsed = parseCSVSafe(csvText);

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
  const EMAIL_BATCH_SIZE = 500;
  
  // Load existing clients in batches
  const clientMap = new Map<string, any>();
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('*')
      .in('email', emailBatch);
    
    existingClients?.forEach(c => clientMap.set(c.email, c));
  }
  
  console.log(`[Subscriptions CSV] Loaded ${clientMap.size} existing clients from DB`);

  // Fetch existing transactions to check for paid status (in batches)
  const paidEmails = new Set<string>();
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingTransactions } = await supabase
      .from('transactions')
      .select('customer_email, status')
      .in('customer_email', emailBatch)
      .in('status', ['succeeded', 'paid']);
    
    existingTransactions?.forEach(t => {
      if (t.customer_email) paidEmails.add(t.customer_email);
    });
  }

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

  // Use safe parser with BOM stripping and header normalization
  const parsed = parseCSVSafe(csvText);

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
  const EMAIL_BATCH_SIZE = 500;
  
  // Load existing clients in batches to avoid Supabase 1000 param limit
  const clientMap = new Map<string, any>();
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('*')
      .in('email', emailBatch);
    
    existingClients?.forEach(c => clientMap.set(c.email, c));
  }
  
  console.log(`[Stripe CSV] Loaded ${clientMap.size} existing clients from DB`);

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

// ============= Stripe Payments CSV Processing (unified_payments.csv) =============

/**
 * Known columns for Stripe unified_payments.csv
 * Anything not in this list goes to raw_data for preservation
 */
const KNOWN_STRIPE_PAYMENTS_COLUMNS = new Set([
  'id', 'amount', 'amount refunded', 'application', 'application fee amount',
  'balance transaction', 'captured', 'card id', 'created (utc)', 'currency',
  'customer description', 'customer email', 'customer id', 'customer name',
  'description', 'destination', 'dispute status', 'disputed', 'failure code',
  'failure message', 'invoice id', 'is link payment', 'metadata', 'on behalf of',
  'payment method type', 'payment source type', 'refunded', 'seller message',
  'source', 'status', 'statement descriptor', 'transfer', 'transfer group'
].map(c => c.toLowerCase()));

export interface StripePaymentsResult extends ProcessingResult {
  totalAmountCents: number;
  uniqueCustomers: number;
  refundedCount: number;
}

/**
 * Processes unified_payments.csv from Stripe.
 * This file contains the complete payment history from Stripe.
 * 
 * COLUMNS: id (ch_/py_), Amount, Amount Refunded, Currency, Customer Email, 
 *          Customer ID, Description, Status, Created (UTC), Invoice ID, etc.
 * 
 * DEDUPLICATION: Uses payment_key = id (ch_xxx or py_xxx) with source='stripe'
 */
export async function processStripePaymentsCSV(csvText: string): Promise<StripePaymentsResult> {
  const result: StripePaymentsResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: [],
    totalAmountCents: 0,
    uniqueCustomers: 0,
    refundedCount: 0
  };

  const parsed = parseCSVSafe(csvText);
  
  console.log(`[Stripe Payments CSV] Parsed ${parsed.data.length} rows`);
  console.log(`[Stripe Payments CSV] Headers:`, Object.keys(parsed.data[0] || {}).slice(0, 10));

  interface ParsedStripePayment {
    id: string;
    email: string;
    stripeCustomerId: string | null;
    customerName: string | null;
    amount: number;
    amountRefunded: number;
    currency: string;
    status: string;
    createdAt: string;
    description: string | null;
    invoiceId: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    paymentMethodType: string | null;
    isRefunded: boolean;
    rawData: Record<string, string>;
  }

  const parsedRowsMap = new Map<string, ParsedStripePayment>();
  const uniqueEmailsSet = new Set<string>();

  for (const row of parsed.data as Record<string, string>[]) {
    // Payment ID - the unique charge/payment ID (ch_ or py_)
    const id = (
      row['id'] || row['ID'] || 
      row['Charge ID'] || row['charge_id'] ||
      ''
    ).trim();

    if (!id) continue;

    // Customer email
    const email = (
      row['Customer Email'] || row['customer_email'] ||
      row['Email'] || row['email'] ||
      ''
    ).toLowerCase().trim();

    if (!email) continue;

    // Skip duplicates within the same file
    if (parsedRowsMap.has(id)) {
      result.transactionsSkipped++;
      continue;
    }

    // Customer ID for identity linking
    const stripeCustomerId = (
      row['Customer ID'] || row['customer_id'] ||
      row['Customer'] || ''
    ).trim() || null;

    // Customer name
    const customerName = (
      row['Customer Name'] || row['customer_name'] ||
      row['Name'] || ''
    ).trim() || null;

    // Amount - Stripe exports in DOLLARS (e.g., 19.50)
    const rawAmount = row['Amount'] || row['amount'] || '0';
    const amountCents = parseCurrency(rawAmount, false);

    // Amount refunded
    const rawAmountRefunded = row['Amount Refunded'] || row['amount_refunded'] || '0';
    const amountRefundedCents = parseCurrency(rawAmountRefunded, false);

    // Currency (normalize to lowercase)
    const currency = (
      row['Currency'] || row['currency'] || 'usd'
    ).toLowerCase().trim();

    // Status normalization
    const rawStatus = (row['Status'] || row['status'] || '').toLowerCase();
    let status = 'pending';
    if (rawStatus === 'paid' || rawStatus === 'succeeded') {
      status = 'succeeded';
    } else if (rawStatus === 'failed' || rawStatus === 'requires_payment_method') {
      status = 'failed';
    } else if (rawStatus === 'pending' || rawStatus === 'processing') {
      status = 'pending';
    } else if (rawStatus === 'refunded') {
      status = 'refunded';
    }

    // Created date
    const createdAt = (
      row['Created (UTC)'] || row['created (utc)'] ||
      row['Created'] || row['created'] ||
      row['Date'] || ''
    ).trim() || new Date().toISOString();

    // Description
    const description = (
      row['Description'] || row['description'] || ''
    ).trim() || null;

    // Invoice ID for linking
    const invoiceId = (
      row['Invoice ID'] || row['invoice_id'] ||
      row['Invoice'] || ''
    ).trim() || null;

    // Failure info
    const failureCode = (row['Failure Code'] || row['failure_code'] || '').trim() || null;
    const failureMessage = (row['Failure Message'] || row['failure_message'] || '').trim() || null;

    // Payment method type
    const paymentMethodType = (
      row['Payment Method Type'] || row['payment_method_type'] ||
      row['Payment Source Type'] || row['payment_source_type'] || ''
    ).trim() || null;

    // Is refunded
    const isRefunded = (
      row['Refunded'] || row['refunded'] || ''
    ).toLowerCase() === 'true' || amountRefundedCents > 0;

    // CATCH-ALL: Extract unmapped columns to raw_data
    const rawData: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase().trim();
      if (!KNOWN_STRIPE_PAYMENTS_COLUMNS.has(keyLower) && value && value.trim()) {
        rawData[key] = value.trim();
      }
    }

    uniqueEmailsSet.add(email);
    if (isRefunded) result.refundedCount++;
    if (status === 'succeeded') result.totalAmountCents += amountCents;

    parsedRowsMap.set(id, {
      id,
      email,
      stripeCustomerId,
      customerName,
      amount: amountCents,
      amountRefunded: amountRefundedCents,
      currency,
      status,
      createdAt,
      description,
      invoiceId,
      failureCode,
      failureMessage,
      paymentMethodType,
      isRefunded,
      rawData
    });
  }

  const parsedRows = Array.from(parsedRowsMap.values());
  result.uniqueCustomers = uniqueEmailsSet.size;
  console.log(`[Stripe Payments CSV] Valid payments: ${parsedRows.length}, Unique customers: ${uniqueEmailsSet.size}`);

  const uniqueEmails = [...uniqueEmailsSet];
  const EMAIL_BATCH_SIZE = 500;
  
  // Load existing clients in batches
  const clientMap = new Map<string, any>();
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('*')
      .in('email', emailBatch);
    
    existingClients?.forEach(c => clientMap.set(c.email, c));
  }
  
  console.log(`[Stripe Payments CSV] Loaded ${clientMap.size} existing clients from DB`);

  // Aggregate payments per email
  const emailPayments = new Map<string, { 
    paidAmountCents: number; 
    hasFailed: boolean; 
    hasPaid: boolean;
    stripeCustomerId: string | null;
    customerName: string | null;
  }>();
  
  for (const row of parsedRows) {
    const existing = emailPayments.get(row.email) || { 
      paidAmountCents: 0, 
      hasFailed: false, 
      hasPaid: false,
      stripeCustomerId: null,
      customerName: null
    };
    
    if (row.status === 'succeeded') {
      existing.paidAmountCents += row.amount;
      existing.hasPaid = true;
    }
    if (row.status === 'failed') {
      existing.hasFailed = true;
    }
    // Keep the first non-null customer ID and name
    if (!existing.stripeCustomerId && row.stripeCustomerId) {
      existing.stripeCustomerId = row.stripeCustomerId;
    }
    if (!existing.customerName && row.customerName) {
      existing.customerName = row.customerName;
    }
    emailPayments.set(row.email, existing);
  }

  // Prepare clients for upsert with lifecycle_stage
  const clientsToUpsert: Array<{
    email: string;
    stripe_customer_id?: string;
    full_name?: string;
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

    const clientData: any = {
      email,
      payment_status: paymentStatus,
      total_paid: newTotalPaid,
      status: existingClient?.status || 'active',
      lifecycle_stage: lifecycle,
      last_sync: new Date().toISOString()
    };

    // Only set stripe_customer_id and full_name if they don't exist
    if (payments.stripeCustomerId && !existingClient?.stripe_customer_id) {
      clientData.stripe_customer_id = payments.stripeCustomerId;
    }
    if (payments.customerName && !existingClient?.full_name) {
      clientData.full_name = payments.customerName;
    }

    clientsToUpsert.push(clientData);

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

  // Prepare transactions with CANONICAL payment_key
  const transactionsToUpsert = parsedRows.map(row => ({
    customer_email: row.email,
    amount: row.amount,
    status: row.status,
    source: 'stripe',
    payment_key: row.id, // CANONICAL dedup key (ch_xxx or py_xxx)
    external_transaction_id: row.id,
    stripe_payment_intent_id: row.id, // For backwards compat
    stripe_customer_id: row.stripeCustomerId,
    stripe_created_at: new Date(row.createdAt).toISOString(),
    currency: row.currency,
    subscription_id: row.invoiceId, // Use invoice_id for subscription linking
    failure_code: row.failureCode,
    failure_message: row.failureMessage,
    payment_type: row.invoiceId ? 'renewal' : 'new', // Simple heuristic
    metadata: Object.keys(row.rawData).length > 0 ? { 
      csv_raw: row.rawData,
      payment_method_type: row.paymentMethodType,
      description: row.description,
      amount_refunded: row.amountRefunded
    } : {
      payment_method_type: row.paymentMethodType,
      description: row.description,
      amount_refunded: row.amountRefunded
    }
  }));

  if (transactionsToUpsert.length > 0) {
    const txBatchResult = await processBatches(transactionsToUpsert, BATCH_SIZE, async (batch) => {
      // Use UNIQUE constraint: (source, payment_key)
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

  console.log(`[Stripe Payments CSV] Complete: ${result.transactionsCreated} transactions, ${result.clientsCreated} new clients, ${result.clientsUpdated} updated`);

  return result;
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

  // Use safe parser with BOM stripping and header normalization
  const parsed = parseCSVSafe(csvText);

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

  // Get existing clients from DB (in batches to avoid 1000 param limit)
  const uniqueEmails = canonicalCustomers.map(c => c.email);
  const EMAIL_BATCH_SIZE = 500;
  const clientMap = new Map<string, any>();
  
  for (let i = 0; i < uniqueEmails.length; i += EMAIL_BATCH_SIZE) {
    const emailBatch = uniqueEmails.slice(i, i + EMAIL_BATCH_SIZE);
    const { data: existingClients } = await supabase
      .from('clients')
      .select('*')
      .in('email', emailBatch);
    
    existingClients?.forEach(c => clientMap.set(c.email, c));
  }
  
  console.log(`[Stripe Customers CSV] Loaded ${clientMap.size} existing clients from DB`);

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

// ============= GoHighLevel CSV Processing =============

export interface GHLProcessingResult {
  clientsCreated: number;
  clientsUpdated: number;
  totalContacts: number;
  withEmail: number;
  withPhone: number;
  withTags: number;
  errors: string[];
}

/**
 * Normalizes a phone number to E.164 format for consistency.
 * Handles Mexican numbers (+52), US numbers (+1), and others.
 */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  
  // Remove all non-digit characters
  let digits = raw.replace(/\D/g, '');
  
  if (!digits || digits.length < 10) return null;
  
  // Handle Mexican numbers
  if (digits.startsWith('52') && digits.length >= 12) {
    return '+' + digits;
  }
  if (digits.length === 10) {
    // Assume Mexican mobile (most common case)
    return '+52' + digits;
  }
  if (digits.startsWith('1') && digits.length === 11) {
    // US/Canada number
    return '+' + digits;
  }
  
  // Default: prepend + if it looks international
  if (digits.length > 10) {
    return '+' + digits;
  }
  
  return '+52' + digits; // Default to Mexico
}

/**
 * Processes GoHighLevel CSV export.
 * 
 * GHL exports typically include columns like:
 * - id, contact id, contactId
 * - email, Email Address
 * - phone, Phone, Mobile
 * - firstName, lastName, name, Full Name
 * - tags, Tags
 * - source, Source
 * - dateCreated, Date Created, createdAt
 * - customField.xxx
 * - dndSettings
 * - etc.
 */
export async function processGoHighLevelCSV(csvText: string): Promise<GHLProcessingResult> {
  const result: GHLProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    totalContacts: 0,
    withEmail: 0,
    withPhone: 0,
    withTags: 0,
    errors: []
  };

  // Use safe parser with BOM stripping (keep lowercase for GHL headers)
  const normalizedText = normalizeCSV(csvText);
  const parsed = Papa.parse(normalizedText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim().toLowerCase(),
    transform: (value) => value?.trim() || ''
  });

  if (!parsed.data || parsed.data.length === 0) {
    result.errors.push('No data found in CSV');
    return result;
  }

  console.log(`[GHL CSV] Parsing ${parsed.data.length} rows`);
  console.log(`[GHL CSV] Headers: ${Object.keys(parsed.data[0] || {}).slice(0, 10).join(', ')}...`);

  interface GHLContact {
    ghlContactId: string;
    email: string | null;
    phone: string | null;
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    tags: string[];
    source: string | null;
    dateCreated: string | null;
    dndEmail: boolean;
    dndSms: boolean;
    dndWhatsApp: boolean;
    customFields: Record<string, string>;
  }

  const contacts: GHLContact[] = [];

  for (const rawRow of parsed.data as Record<string, string>[]) {
    // GHL exports have various column name formats
    const ghlContactId = rawRow['id'] || rawRow['contact id'] || rawRow['contactid'] || '';
    
    if (!ghlContactId) continue;
    
    // Email - multiple possible column names
    let email = rawRow['email'] || rawRow['email address'] || rawRow['emailaddress'] || '';
    if (email) {
      email = email.toLowerCase().trim();
      // Validate email format
      if (!email.includes('@')) {
        email = '';
      }
    }
    
    // Phone - multiple possible column names
    const rawPhone = rawRow['phone'] || rawRow['mobile'] || rawRow['phonenumber'] || rawRow['phone number'] || '';
    const phone = normalizePhone(rawPhone);
    
    // Skip if no email AND no phone (can't match/create)
    if (!email && !phone) {
      result.errors.push(`Contact ${ghlContactId}: No email or phone`);
      continue;
    }
    
    // Name
    const firstName = rawRow['firstname'] || rawRow['first name'] || rawRow['first_name'] || '';
    const lastName = rawRow['lastname'] || rawRow['last name'] || rawRow['last_name'] || '';
    let fullName = rawRow['name'] || rawRow['full name'] || rawRow['fullname'] || '';
    
    if (!fullName && (firstName || lastName)) {
      fullName = `${firstName} ${lastName}`.trim();
    }
    
    // Tags - can be comma-separated or JSON array
    let tags: string[] = [];
    const rawTags = rawRow['tags'] || rawRow['tag'] || '';
    if (rawTags) {
      try {
        // Try JSON array first
        if (rawTags.startsWith('[')) {
          tags = JSON.parse(rawTags);
        } else {
          // Comma-separated
          tags = rawTags.split(',').map(t => t.trim()).filter(t => t);
        }
      } catch {
        tags = rawTags.split(',').map(t => t.trim()).filter(t => t);
      }
    }
    
    // Source
    const source = rawRow['source'] || rawRow['lead source'] || rawRow['leadsource'] || '';
    
    // Date created
    const dateCreated = rawRow['datecreated'] || rawRow['date created'] || rawRow['createdat'] || rawRow['created at'] || '';
    
    // DND settings
    const dndRaw = rawRow['dndsettings'] || rawRow['dnd'] || '';
    let dndEmail = false, dndSms = false, dndWhatsApp = false;
    if (dndRaw) {
      try {
        const dnd = typeof dndRaw === 'string' && dndRaw.startsWith('{') ? JSON.parse(dndRaw) : {};
        dndEmail = dnd.Email?.status === 'active' || dnd.email === true;
        dndSms = dnd.SMS?.status === 'active' || dnd.sms === true;
        dndWhatsApp = dnd.WhatsApp?.status === 'active' || dnd.whatsapp === true;
      } catch {
        // Ignore DND parsing errors
      }
    }
    
    // Custom fields - collect any column starting with "customfield" or has a dot
    const customFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawRow)) {
      if ((key.startsWith('customfield') || key.includes('.')) && value) {
        customFields[key] = value;
      }
    }
    
    contacts.push({
      ghlContactId,
      email: email || null,
      phone,
      fullName: fullName || null,
      firstName: firstName || null,
      lastName: lastName || null,
      tags,
      source: source || null,
      dateCreated: dateCreated || null,
      dndEmail,
      dndSms,
      dndWhatsApp,
      customFields
    });
    
    result.totalContacts++;
    if (email) result.withEmail++;
    if (phone) result.withPhone++;
    if (tags.length > 0) result.withTags++;
  }

  console.log(`[GHL CSV] Valid contacts: ${contacts.length}`);
  console.log(`[GHL CSV] With email: ${result.withEmail}, With phone: ${result.withPhone}`);

  // Group contacts by email for matching
  const emailContacts = contacts.filter(c => c.email);
  const phoneOnlyContacts = contacts.filter(c => !c.email && c.phone);

  // Load existing clients by email
  const uniqueEmails = [...new Set(emailContacts.map(c => c.email!))];
  const existingByEmail = new Map<string, any>();
  
  for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
    const { data } = await supabase
      .from('clients')
      .select('*')
      .in('email', batch);
    
    data?.forEach(c => existingByEmail.set(c.email, c));
  }

  // Load existing clients by phone for phone-only contacts
  const uniquePhones = [...new Set(phoneOnlyContacts.map(c => c.phone!))];
  const existingByPhone = new Map<string, any>();
  
  for (let i = 0; i < uniquePhones.length; i += BATCH_SIZE) {
    const batch = uniquePhones.slice(i, i + BATCH_SIZE);
    const { data } = await supabase
      .from('clients')
      .select('*')
      .in('phone', batch);
    
    data?.forEach(c => {
      if (c.phone) existingByPhone.set(c.phone, c);
    });
  }

  console.log(`[GHL CSV] Found ${existingByEmail.size} existing by email, ${existingByPhone.size} by phone`);

  // Prepare upsert records
  interface ClientUpsert {
    email?: string;
    phone?: string;
    full_name?: string;
    ghl_contact_id: string;
    tags?: string[];
    acquisition_source?: string;
    first_seen_at?: string;
    email_opt_in?: boolean;
    sms_opt_in?: boolean;
    wa_opt_in?: boolean;
    customer_metadata?: Record<string, any>;
    lifecycle_stage?: string;
    last_sync?: string;
  }

  const toUpsert: ClientUpsert[] = [];
  const toInsertPhoneOnly: ClientUpsert[] = [];

  for (const contact of emailContacts) {
    const existing = existingByEmail.get(contact.email!);
    
    const record: ClientUpsert = {
      email: contact.email!,
      ghl_contact_id: contact.ghlContactId,
      last_sync: new Date().toISOString()
    };
    
    // Only update fields if not already set (don't overwrite payment data)
    if (!existing?.full_name && contact.fullName) {
      record.full_name = contact.fullName;
    }
    if (!existing?.phone && contact.phone) {
      record.phone = contact.phone;
    }
    if (contact.tags.length > 0) {
      // Merge tags
      const existingTags = existing?.tags || [];
      record.tags = [...new Set([...existingTags, ...contact.tags])];
    }
    if (!existing?.acquisition_source && contact.source) {
      record.acquisition_source = 'ghl';
    }
    if (!existing?.first_seen_at && contact.dateCreated) {
      try {
        record.first_seen_at = new Date(contact.dateCreated).toISOString();
      } catch {
        // Invalid date
      }
    }
    
    // Opt-in: default true unless DND is active
    record.email_opt_in = !contact.dndEmail;
    record.sms_opt_in = !contact.dndSms;
    record.wa_opt_in = !contact.dndWhatsApp;
    
    // Store custom fields in metadata
    if (Object.keys(contact.customFields).length > 0) {
      record.customer_metadata = {
        ...(existing?.customer_metadata || {}),
        ghl_custom_fields: contact.customFields
      };
    }
    
    // Keep existing lifecycle stage if set
    if (!existing?.lifecycle_stage || existing.lifecycle_stage === 'LEAD') {
      record.lifecycle_stage = 'LEAD';
    }
    
    toUpsert.push(record);
    
    if (existing) {
      result.clientsUpdated++;
    } else {
      result.clientsCreated++;
    }
  }

  // Handle phone-only contacts
  for (const contact of phoneOnlyContacts) {
    const existing = existingByPhone.get(contact.phone!);
    
    if (existing) {
      // Update existing phone-matched record
      const record: ClientUpsert = {
        email: existing.email, // Use existing email for upsert key
        ghl_contact_id: contact.ghlContactId,
        last_sync: new Date().toISOString()
      };
      
      if (!existing.full_name && contact.fullName) {
        record.full_name = contact.fullName;
      }
      if (contact.tags.length > 0) {
        record.tags = [...new Set([...(existing.tags || []), ...contact.tags])];
      }
      
      if (existing.email) {
        toUpsert.push(record);
      }
      result.clientsUpdated++;
    } else {
      // Create new phone-only record (no email)
      toInsertPhoneOnly.push({
        phone: contact.phone!,
        full_name: contact.fullName || undefined,
        ghl_contact_id: contact.ghlContactId,
        tags: contact.tags.length > 0 ? contact.tags : undefined,
        acquisition_source: 'ghl',
        first_seen_at: contact.dateCreated ? new Date(contact.dateCreated).toISOString() : undefined,
        sms_opt_in: !contact.dndSms,
        wa_opt_in: !contact.dndWhatsApp,
        lifecycle_stage: 'LEAD',
        last_sync: new Date().toISOString()
      });
      result.clientsCreated++;
    }
  }

  // Execute upserts in batches (email-based)
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('clients')
      .upsert(batch, { onConflict: 'email' });
    
    if (error) {
      console.error(`[GHL CSV] Upsert batch error:`, error);
      result.errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
    }
  }

  // Insert phone-only records
  for (let i = 0; i < toInsertPhoneOnly.length; i += BATCH_SIZE) {
    const batch = toInsertPhoneOnly.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('clients')
      .insert(batch);
    
    if (error) {
      console.error(`[GHL CSV] Insert phone-only batch error:`, error);
      result.errors.push(`Phone-only batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
    }
  }

  console.log(`[GHL CSV] Complete: ${result.clientsCreated} created, ${result.clientsUpdated} updated`);
  
  return result;
}
