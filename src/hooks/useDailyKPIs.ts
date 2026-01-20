import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type TimeFilter = 'today' | '7d' | 'month';

export interface DailyKPIs {
  // Registrations
  registrationsToday: number;
  // Trials
  trialsStartedToday: number;
  // Conversions
  trialConversionsToday: number;
  // New payers (first payment ever)
  newPayersToday: number;
  // Renewals
  renewalsToday: number;
  // Failures
  failuresToday: number;
  failureReasons: Array<{ reason: string; count: number }>;
  // Cancellations
  cancellationsToday: number;
  // Revenue breakdown
  newRevenue: number;
  conversionRevenue: number;
  renewalRevenue: number;
}

const defaultKPIs: DailyKPIs = {
  registrationsToday: 0,
  trialsStartedToday: 0,
  trialConversionsToday: 0,
  newPayersToday: 0,
  renewalsToday: 0,
  failuresToday: 0,
  failureReasons: [],
  cancellationsToday: 0,
  newRevenue: 0,
  conversionRevenue: 0,
  renewalRevenue: 0,
};

function getDateRange(filter: TimeFilter): { start: Date; end: Date } {
  const now = new Date();
  const end = now;
  let start: Date;

  switch (filter) {
    case 'today':
      // Use UTC to match database timestamps
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      break;
    case '7d':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      // First day of current month in UTC
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      break;
    default:
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  console.log(`📊 KPI date range (${filter}): ${start.toISOString()} to ${end.toISOString()}`);
  return { start, end };
}

export function useDailyKPIs(filter: TimeFilter = 'today') {
  const [kpis, setKPIs] = useState<DailyKPIs>(defaultKPIs);
  const [isLoading, setIsLoading] = useState(true);

  const fetchKPIs = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = getDateRange(filter);
      const startISO = start.toISOString();
      const endISO = end.toISOString();

      console.log(`🔍 Fetching KPIs for ${filter}: ${startISO} to ${endISO}`);

      // Fetch transactions in date range
      const { data: transactions, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .gte('stripe_created_at', startISO)
        .lte('stripe_created_at', endISO);

      if (txError) {
        console.error('❌ Error fetching transactions:', txError);
      }
      
      console.log(`📊 Found ${transactions?.length || 0} transactions in range`);
      
      // Debug: show first few transactions
      if (transactions && transactions.length > 0) {
        console.log('📋 Sample transactions:', transactions.slice(0, 3).map(t => ({
          email: t.customer_email,
          amount: t.amount,
          status: t.status,
          date: t.stripe_created_at
        })));
      }

      // Get FIRST payment date for each customer email
      // Load all paid transactions ordered by date to find first payments
      const { data: firstPaymentDates } = await supabase
        .from('transactions')
        .select('customer_email, stripe_created_at')
        .in('status', ['paid', 'succeeded'])
        .not('customer_email', 'is', null)
        .order('stripe_created_at', { ascending: true });

      // Build a map of email -> first payment date
      const firstPaymentDateByEmail = new Map<string, string>();
      for (const tx of firstPaymentDates || []) {
        if (tx.customer_email && !firstPaymentDateByEmail.has(tx.customer_email)) {
          firstPaymentDateByEmail.set(tx.customer_email, tx.stripe_created_at || '');
        }
      }
      
      console.log(`📊 Found ${firstPaymentDateByEmail.size} unique customers with first payment dates`);

      // Fetch subscriptions for trial info
      const { data: subscriptions } = await supabase
        .from('subscriptions')
        .select('*');

      // Fetch clients for registrations
      const { data: clients } = await supabase
        .from('clients')
        .select('email, created_at, trial_started_at')
        .gte('created_at', startISO)
        .lte('created_at', endISO);

      // Fetch cancellations (subscriptions canceled in period)
      const { data: canceledSubs } = await supabase
        .from('subscriptions')
        .select('*')
        .not('canceled_at', 'is', null)
        .gte('canceled_at', startISO)
        .lte('canceled_at', endISO);

      // Calculate KPIs
      let trialsStartedToday = 0;
      let trialConversionsToday = 0;
      let newPayersToday = 0;
      let renewalsToday = 0;
      let failuresToday = 0;
      let newRevenue = 0;
      let conversionRevenue = 0;
      let renewalRevenue = 0;
      const failureReasonsMap = new Map<string, number>();

      // Build subscription map for quick lookup
      const subMap = new Map<string, any>();
      for (const sub of subscriptions || []) {
        subMap.set(sub.stripe_subscription_id, sub);
      }

      const allTransactions = transactions || [];

      // Now classify each transaction in the date range
      for (const tx of allTransactions) {
        const amountCents = tx.amount || 0;

        // Handle failures
        if (tx.status === 'failed') {
          failuresToday++;
          const reason = tx.failure_code || tx.failure_message || 'unknown';
          failureReasonsMap.set(reason, (failureReasonsMap.get(reason) || 0) + 1);
          continue;
        }

        // Only count paid transactions
        if (tx.status !== 'paid' && tx.status !== 'succeeded') continue;

        const sub = subMap.get(tx.subscription_id || '');
        
        // Check if this transaction date matches the customer's first payment date
        const firstPaymentDate = tx.customer_email ? firstPaymentDateByEmail.get(tx.customer_email) : null;
        const isFirstPayment = firstPaymentDate && tx.stripe_created_at === firstPaymentDate;

        // Check if this is a trial conversion
        const hasTrialEnded = sub?.trial_end && new Date(sub.trial_end) <= new Date(tx.stripe_created_at || '');
        
        // Determine payment type
        let paymentType = tx.payment_type;
        
        if (!paymentType || paymentType === 'unknown') {
          if (isFirstPayment) {
            if (hasTrialEnded) {
              paymentType = 'trial_conversion';
            } else {
              paymentType = 'new';
            }
          } else {
            paymentType = 'renewal';
          }
        }

        // Count based on type
        switch (paymentType) {
          case 'new':
            newPayersToday++;
            newRevenue += amountCents;
            break;
          case 'trial_conversion':
            trialConversionsToday++;
            conversionRevenue += amountCents;
            break;
          case 'renewal':
            renewalsToday++;
            renewalRevenue += amountCents;
            break;
        }
      }

      // Count trials started (from clients with trial_started_at in range)
      const { data: trialClients } = await supabase
        .from('clients')
        .select('email')
        .gte('trial_started_at', startISO)
        .lte('trial_started_at', endISO);
      
      trialsStartedToday = trialClients?.length || 0;

      // Also count subscriptions in trialing status created in range
      const { data: trialingSubs } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('status', 'trialing')
        .gte('created_at', startISO)
        .lte('created_at', endISO);
      
      trialsStartedToday = Math.max(trialsStartedToday, trialingSubs?.length || 0);

      // Convert failure reasons map to array
      const failureReasons = Array.from(failureReasonsMap.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

      const calculatedKPIs = {
        registrationsToday: clients?.length || 0,
        trialsStartedToday,
        trialConversionsToday,
        newPayersToday,
        renewalsToday,
        failuresToday,
        failureReasons,
        cancellationsToday: canceledSubs?.length || 0,
        newRevenue: newRevenue / 100, // Convert cents to dollars
        conversionRevenue: conversionRevenue / 100,
        renewalRevenue: renewalRevenue / 100,
      };
      
      console.log('✅ Calculated KPIs:', {
        newPayersToday,
        renewalsToday,
        trialConversionsToday,
        failuresToday,
        newRevenue: newRevenue / 100,
        renewalRevenue: renewalRevenue / 100,
        conversionRevenue: conversionRevenue / 100,
        total: (newRevenue + renewalRevenue + conversionRevenue) / 100
      });
      
      setKPIs(calculatedKPIs);
    } catch (error) {
      console.error('Error fetching daily KPIs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchKPIs();
  }, [fetchKPIs]);

  return { kpis, isLoading, refetch: fetchKPIs };
}
