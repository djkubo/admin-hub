import Papa from 'papaparse';
import { supabase } from "@/integrations/supabase/client";

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

// ============= PayPal CSV Processing =============

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

  for (const row of parsed.data as Record<string, string>[]) {
    // Map PayPal columns - "Correo electrónico del remitente", "Bruto", "Estado", "Fecha y Hora"
    const email = row['Correo electrónico del remitente']?.trim() || row['From Email Address']?.trim();
    const rawAmount = row['Bruto']?.trim() || row['Gross']?.trim() || '0';
    const rawStatus = row['Estado']?.trim() || row['Status']?.trim() || '';
    const rawDate = row['Fecha y Hora']?.trim() || row['Date Time']?.trim() || row['Fecha']?.trim();
    const transactionId = row['Id. de transacción']?.trim() || row['Transaction ID']?.trim() || `paypal_${Date.now()}_${Math.random()}`;

    if (!email) continue;

    // Clean amount - remove currency symbols, commas, spaces
    const cleanedAmount = rawAmount.replace(/[^\d.-]/g, '').replace(',', '.');
    const amount = parseFloat(cleanedAmount) || 0;

    // Map status
    let status = 'pending';
    const lowerStatus = rawStatus.toLowerCase();
    if (lowerStatus.includes('completado') || lowerStatus.includes('completed')) {
      status = 'paid';
    } else if (lowerStatus.includes('declinado') || lowerStatus.includes('rechazado') || 
               lowerStatus.includes('cancelado') || lowerStatus.includes('declined') ||
               lowerStatus.includes('rejected') || lowerStatus.includes('canceled')) {
      status = 'failed';
    }

    // Parse date
    let transactionDate = new Date();
    if (rawDate) {
      // Try multiple date formats
      const parsedDate = new Date(rawDate);
      if (!isNaN(parsedDate.getTime())) {
        transactionDate = parsedDate;
      }
    }

    // Cache for metrics
    paypalTransactionsCache.push({ email, amount, status, date: transactionDate });

    // Check for duplicate transaction
    const { data: existingTx } = await supabase
      .from('transactions')
      .select('id')
      .eq('external_transaction_id', transactionId)
      .eq('source', 'paypal')
      .maybeSingle();

    if (existingTx) {
      result.transactionsSkipped++;
      continue;
    }

    // Upsert client
    const { data: existingClient } = await supabase
      .from('clients')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    const newTotalPaid = (existingClient?.total_paid || 0) + (status === 'paid' ? amount : 0);
    let paymentStatus = existingClient?.payment_status || 'none';
    
    if (status === 'paid') {
      paymentStatus = 'paid';
    } else if (status === 'failed' && paymentStatus !== 'paid') {
      paymentStatus = 'failed';
    }

    if (existingClient) {
      await supabase
        .from('clients')
        .update({
          payment_status: paymentStatus,
          total_paid: newTotalPaid,
          last_sync: new Date().toISOString()
        })
        .eq('email', email);
      result.clientsUpdated++;
    } else {
      await supabase
        .from('clients')
        .insert({
          email,
          payment_status: paymentStatus,
          total_paid: status === 'paid' ? amount : 0,
          status: 'active',
          last_sync: new Date().toISOString()
        });
      result.clientsCreated++;
    }

    // Determine currency from raw amount string
    const currency = rawAmount.toLowerCase().includes('mxn') ? 'mxn' : 'usd';

    // Create transaction - persist PayPal data to Supabase
    const { error: txError } = await supabase
      .from('transactions')
      .insert({
        customer_email: email,
        amount: Math.round(amount * 100), // Store in cents like Stripe
        status: status, // Use mapped status directly: 'paid' or 'failed'
        source: 'paypal',
        external_transaction_id: transactionId,
        stripe_payment_intent_id: `paypal_${transactionId}`,
        stripe_created_at: transactionDate.toISOString(),
        currency: currency,
        failure_code: status === 'failed' ? 'payment_failed' : null,
        failure_message: status === 'failed' ? 'Pago rechazado/declinado por PayPal' : null
      });

    if (txError) {
      result.errors.push(`Error guardando transacción PayPal ${transactionId}: ${txError.message}`);
    } else {
      result.transactionsCreated++;
    }
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
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  for (const row of parsed.data as Record<string, string>[]) {
    // Map Web columns - "Email", "Telefono", "Nombre"
    const email = row['Email']?.trim() || row['email']?.trim() || row['Correo']?.trim();
    const phone = row['Telefono']?.trim() || row['telefono']?.trim() || row['Phone']?.trim() || row['Teléfono']?.trim();
    const fullName = row['Nombre']?.trim() || row['nombre']?.trim() || row['Name']?.trim() || row['Nombre completo']?.trim();

    if (!email) continue;

    const { data: existing } = await supabase
      .from('clients')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      const updates: Record<string, string | null> = {};
      
      // Always update phone if provided (critical for WhatsApp)
      if (phone) updates.phone = phone;
      if (fullName && !existing.full_name) updates.full_name = fullName;

      if (Object.keys(updates).length > 0) {
        const { error } = await supabase
          .from('clients')
          .update({ ...updates, last_sync: new Date().toISOString() })
          .eq('email', email);
        
        if (error) result.errors.push(`Error updating ${email}: ${error.message}`);
        else result.clientsUpdated++;
      }
    } else {
      const { error } = await supabase
        .from('clients')
        .insert({
          email,
          full_name: fullName || null,
          phone: phone || null,
          status: 'active',
          last_sync: new Date().toISOString()
        });
      
      if (error) result.errors.push(`Error creating ${email}: ${error.message}`);
      else result.clientsCreated++;
    }
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
    // Map Subscriptions columns - "Plan Name", "Status", "Created At (CDMX)"
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
  
  // ALL successful transactions from today (from DB - includes both Stripe and PayPal)
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
    // Check if already in DB results to avoid double-counting
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

  // Convert MXN to USD (approximate rate)
  const MXN_TO_USD = 0.05; // 1 MXN = 0.05 USD (approx 20 MXN = 1 USD)
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
    
    // Count as converted if was on trial and now Active with paid plan
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
      // Check if expired in last 30 days
      if (sub.createdAt) {
        const createdDate = new Date(sub.createdAt);
        if (createdDate >= thirtyDaysAgo) {
          churnCount++;
        }
      } else {
        churnCount++; // Count it if no date available
      }
    }
  }

  // ============= Recovery List =============
  
  // Get failed transactions from DB (Stripe)
  const { data: failedStripeTransactions } = await supabase
    .from('transactions')
    .select('customer_email, amount, source')
    .in('status', ['failed', 'canceled']);

  // Get failed PayPal from cache
  const failedPayPal = paypalTransactionsCache.filter(tx => tx.status === 'failed');

  // Combine all failed transactions
  const allFailedEmails = new Set<string>();
  const failedAmounts: Record<string, { amount: number; source: string }> = {};

  for (const tx of failedStripeTransactions || []) {
    if (tx.customer_email) {
      allFailedEmails.add(tx.customer_email);
      if (!failedAmounts[tx.customer_email]) {
        failedAmounts[tx.customer_email] = { amount: 0, source: 'stripe' };
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

  // Fetch client info for recovery list
  const recoveryList: RecoveryClient[] = [];

  if (allFailedEmails.size > 0) {
    const { data: clients } = await supabase
      .from('clients')
      .select('email, full_name, phone')
      .in('email', Array.from(allFailedEmails));

    for (const client of clients || []) {
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

    // Also add failed emails without client records
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
  
  // For Stripe, use the original logic with updated parsing
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

  for (const row of parsed.data as Record<string, string>[]) {
    const email = row['email']?.trim() || row['Email']?.trim() || row['customer_email']?.trim();
    const transactionId = row['transaction_id']?.trim() || row['id']?.trim() || row['ID']?.trim();
    const rawAmount = row['amount']?.trim() || row['Amount']?.trim() || '0';
    const status = row['status']?.trim() || row['Status']?.trim() || 'pending';
    const date = row['date']?.trim() || row['Date']?.trim() || row['created']?.trim();

    if (!email || !transactionId) continue;

    const amount = parseFloat(rawAmount.replace(/[^\d.-]/g, '')) || 0;

    // Check deduplication
    const { data: existingTx } = await supabase
      .from('transactions')
      .select('id')
      .eq('external_transaction_id', transactionId)
      .eq('source', 'stripe')
      .maybeSingle();

    if (existingTx) {
      result.transactionsSkipped++;
      continue;
    }

    // Upsert client
    const { data: existingClient } = await supabase
      .from('clients')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    const isPaid = status === 'succeeded' || status === 'paid';
    const newTotalPaid = (existingClient?.total_paid || 0) + (isPaid ? amount : 0);
    let paymentStatus = existingClient?.payment_status || 'none';
    
    if (isPaid) paymentStatus = 'paid';
    else if (status === 'failed' && paymentStatus !== 'paid') paymentStatus = 'failed';

    if (existingClient) {
      await supabase
        .from('clients')
        .update({
          payment_status: paymentStatus,
          total_paid: newTotalPaid,
          last_sync: new Date().toISOString()
        })
        .eq('email', email);
      result.clientsUpdated++;
    } else {
      await supabase
        .from('clients')
        .insert({
          email,
          payment_status: paymentStatus,
          total_paid: isPaid ? amount : 0,
          status: 'active',
          last_sync: new Date().toISOString()
        });
      result.clientsCreated++;
    }

    const transactionDate = date ? new Date(date).toISOString() : new Date().toISOString();
    
    const { error: txError } = await supabase
      .from('transactions')
      .insert({
        customer_email: email,
        amount: Math.round(amount * 100),
        status,
        source: 'stripe',
        external_transaction_id: transactionId,
        stripe_payment_intent_id: `stripe_${transactionId}`,
        stripe_created_at: transactionDate,
        failure_code: status === 'failed' ? 'payment_failed' : null,
        failure_message: status === 'failed' ? 'Payment failed' : null
      });

    if (txError) result.errors.push(`Error transaction ${transactionId}: ${txError.message}`);
    else result.transactionsCreated++;
  }

  return result;
}
