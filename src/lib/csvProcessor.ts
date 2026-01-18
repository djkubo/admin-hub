import { supabase } from "@/integrations/supabase/client";

export interface WebCSVRow {
  email: string;
  full_name?: string;
  phone?: string;
  status?: string;
}

export interface StripeCSVRow {
  transaction_id: string;
  email: string;
  amount: number;
  status: string;
  date: string;
}

export interface PayPalCSVRow {
  transaction_id: string;
  email: string;
  amount: number;
  status: string;
  date: string;
}

export interface ProcessingResult {
  clientsCreated: number;
  clientsUpdated: number;
  transactionsCreated: number;
  transactionsSkipped: number;
  errors: string[];
}

function parseCSV<T>(csvText: string): T[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows: T[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string | number> = {};
    
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    
    rows.push(row as T);
  }

  return rows;
}

export async function processWebCSV(csvText: string): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: []
  };

  const rows = parseCSV<WebCSVRow>(csvText);

  for (const row of rows) {
    if (!row.email) continue;

    const { data: existing } = await supabase
      .from('clients')
      .select('*')
      .eq('email', row.email)
      .maybeSingle();

    if (existing) {
      // Update existing client with new phone if provided
      const updates: Record<string, string | null> = {};
      if (row.phone && !existing.phone) updates.phone = row.phone;
      if (row.full_name && !existing.full_name) updates.full_name = row.full_name;
      if (row.status) updates.status = row.status;

      if (Object.keys(updates).length > 0) {
        const { error } = await supabase
          .from('clients')
          .update({ ...updates, last_sync: new Date().toISOString() })
          .eq('email', row.email);
        
        if (error) result.errors.push(`Error updating ${row.email}: ${error.message}`);
        else result.clientsUpdated++;
      }
    } else {
      // Create new client
      const { error } = await supabase
        .from('clients')
        .insert({
          email: row.email,
          full_name: row.full_name || null,
          phone: row.phone || null,
          status: row.status || 'active',
          last_sync: new Date().toISOString()
        });
      
      if (error) result.errors.push(`Error creating ${row.email}: ${error.message}`);
      else result.clientsCreated++;
    }
  }

  return result;
}

export async function processPaymentCSV(
  csvText: string, 
  source: 'stripe' | 'paypal'
): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    clientsCreated: 0,
    clientsUpdated: 0,
    transactionsCreated: 0,
    transactionsSkipped: 0,
    errors: []
  };

  const rows = parseCSV<StripeCSVRow | PayPalCSVRow>(csvText);

  for (const row of rows) {
    if (!row.email || !row.transaction_id) continue;

    // Check for duplicate transaction (deduplication)
    const { data: existingTx } = await supabase
      .from('transactions')
      .select('id')
      .eq('external_transaction_id', row.transaction_id)
      .eq('source', source)
      .maybeSingle();

    if (existingTx) {
      result.transactionsSkipped++;
      continue;
    }

    // Upsert client
    const { data: existingClient } = await supabase
      .from('clients')
      .select('*')
      .eq('email', row.email)
      .maybeSingle();

    const amount = typeof row.amount === 'string' ? parseFloat(row.amount) : row.amount;
    const newTotalPaid = (existingClient?.total_paid || 0) + (row.status === 'succeeded' || row.status === 'paid' ? amount : 0);
    
    // Determine payment status based on transaction status
    let paymentStatus = existingClient?.payment_status || 'none';
    if (row.status === 'succeeded' || row.status === 'paid') {
      paymentStatus = 'paid';
    } else if (row.status === 'failed' || row.status === 'canceled') {
      if (paymentStatus !== 'paid') paymentStatus = row.status;
    }

    // Check for trial to paid conversion
    const wasTrialConverted = existingClient?.status === 'trial' && paymentStatus === 'paid';

    if (existingClient) {
      const { error } = await supabase
        .from('clients')
        .update({
          payment_status: paymentStatus,
          total_paid: newTotalPaid,
          converted_at: wasTrialConverted ? new Date().toISOString() : existingClient.converted_at,
          last_sync: new Date().toISOString()
        })
        .eq('email', row.email);
      
      if (error) result.errors.push(`Error updating client ${row.email}: ${error.message}`);
      else result.clientsUpdated++;
    } else {
      const { error } = await supabase
        .from('clients')
        .insert({
          email: row.email,
          payment_status: paymentStatus,
          total_paid: row.status === 'succeeded' || row.status === 'paid' ? amount : 0,
          status: 'active',
          last_sync: new Date().toISOString()
        });
      
      if (error) result.errors.push(`Error creating client ${row.email}: ${error.message}`);
      else result.clientsCreated++;
    }

    // Create transaction record
    const transactionDate = row.date ? new Date(row.date).toISOString() : new Date().toISOString();
    
    const { error: txError } = await supabase
      .from('transactions')
      .insert({
        customer_email: row.email,
        amount: Math.round(amount * 100), // Store in cents
        status: row.status,
        source: source,
        external_transaction_id: row.transaction_id,
        stripe_payment_intent_id: `${source}_${row.transaction_id}`,
        stripe_created_at: transactionDate,
        failure_code: row.status === 'failed' ? 'payment_failed' : null,
        failure_message: row.status === 'failed' ? 'Payment failed' : null
      });

    if (txError) result.errors.push(`Error creating transaction ${row.transaction_id}: ${txError.message}`);
    else result.transactionsCreated++;
  }

  return result;
}

export async function getMetrics() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  // Sales Today - sum of successful transactions from today
  const { data: todayTransactions } = await supabase
    .from('transactions')
    .select('amount, status, stripe_created_at')
    .gte('stripe_created_at', todayISO)
    .in('status', ['succeeded', 'paid']);

  const salesToday = (todayTransactions || []).reduce((sum, tx) => sum + (tx.amount / 100), 0);

  // Conversion Rate - users that converted from trial to paid
  const { count: trialCount } = await supabase
    .from('clients')
    .select('*', { count: 'exact', head: true })
    .or('status.eq.trial,converted_at.not.is.null');

  const { count: convertedCount } = await supabase
    .from('clients')
    .select('*', { count: 'exact', head: true })
    .not('converted_at', 'is', null);

  const conversionRate = trialCount && trialCount > 0 
    ? ((convertedCount || 0) / trialCount) * 100 
    : 0;

  // Recovery List - users with failed/canceled status uploaded today
  const { data: recoveryList } = await supabase
    .from('clients')
    .select('email, full_name, phone, payment_status')
    .in('payment_status', ['failed', 'canceled'])
    .gte('last_sync', todayISO);

  return {
    salesToday,
    conversionRate,
    recoveryList: recoveryList || [],
    trialCount: trialCount || 0,
    convertedCount: convertedCount || 0
  };
}
