import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface DashboardMetrics {
  // Today's sales
  salesTodayUSD: number;
  salesTodayMXN: number;
  salesTodayTotal: number;
  // Month's sales (GROSS)
  salesMonthUSD: number;
  salesMonthMXN: number;
  salesMonthTotal: number;
  // NET Revenue (after refunds)
  refundsMonthUSD: number;
  refundsMonthMXN: number;
  refundsMonthTotal: number;
  netRevenueMonthUSD: number;
  netRevenueMonthMXN: number;
  netRevenueMonthTotal: number;
  conversionRate: number;
  trialCount: number;
  convertedCount: number;
  churnCount: number;
  recoveryList: Array<{
    email: string;
    full_name: string | null;
    phone: string | null;
    amount: number;
    source: string;
    recovery_status?: 'pending' | 'contacted' | 'paid' | 'lost';
  }>;
  // New lifecycle counts
  leadCount: number;
  customerCount: number;
}

const defaultMetrics: DashboardMetrics = {
  salesTodayUSD: 0,
  salesTodayMXN: 0,
  salesTodayTotal: 0,
  salesMonthUSD: 0,
  salesMonthMXN: 0,
  salesMonthTotal: 0,
  refundsMonthUSD: 0,
  refundsMonthMXN: 0,
  refundsMonthTotal: 0,
  netRevenueMonthUSD: 0,
  netRevenueMonthMXN: 0,
  netRevenueMonthTotal: 0,
  conversionRate: 0,
  trialCount: 0,
  convertedCount: 0,
  churnCount: 0,
  recoveryList: [],
  leadCount: 0,
  customerCount: 0
};

export function useMetrics() {
  const [metrics, setMetrics] = useState<DashboardMetrics>(defaultMetrics);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      // Use timezone-aware date calculation matching server (America/Mexico_City)
      // Get current time and calculate dates using Mexico City timezone offset
      const now = new Date();
      
      // Calculate first day of month in Mexico City time
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      // Start of today in Mexico City time (UTC-6, accounting for DST)
      // The server RPCs use America/Mexico_City, so we need to match
      const mexicoOffsetHours = -6; // CST (adjust if DST is needed)
      const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000);
      const mexicoNow = new Date(utcNow.getTime() + mexicoOffsetHours * 3600000);
      const startOfTodayMexico = new Date(mexicoNow.getFullYear(), mexicoNow.getMonth(), mexicoNow.getDate());
      // Convert back to UTC for database query
      const startOfTodayUTC = new Date(startOfTodayMexico.getTime() - mexicoOffsetHours * 3600000);
      
      // Fetch monthly transactions - include refunded for NET calculation
      // OPTIMIZATION: Limit to 5000 rows max to prevent statement timeout
      const { data: monthlyTransactions } = await supabase
        .from('transactions')
        .select('amount, currency, status, stripe_created_at')
        .gte('stripe_created_at', firstDayOfMonth.toISOString())
        .in('status', ['succeeded', 'paid', 'refunded'])
        .order('stripe_created_at', { ascending: false })
        .limit(5000); // Safety limit

      let salesMonthUSD = 0;
      let salesMonthMXN = 0;
      let salesTodayUSD = 0;
      let salesTodayMXN = 0;
      let refundsMonthUSD = 0;
      let refundsMonthMXN = 0;

      // All amounts stored in CENTS, divide by 100 for display
      for (const tx of monthlyTransactions || []) {
        const amountInCurrency = tx.amount / 100;
        const txDate = tx.stripe_created_at ? new Date(tx.stripe_created_at) : null;
        const isToday = txDate && txDate >= startOfTodayUTC;
        const isRefund = tx.status === 'refunded';
        
        if (tx.currency?.toLowerCase() === 'mxn') {
          if (isRefund) {
            refundsMonthMXN += amountInCurrency;
          } else {
            salesMonthMXN += amountInCurrency;
            if (isToday) salesTodayMXN += amountInCurrency;
          }
        } else {
          if (isRefund) {
            refundsMonthUSD += amountInCurrency;
          } else {
            salesMonthUSD += amountInCurrency;
            if (isToday) salesTodayUSD += amountInCurrency;
          }
        }
      }

      const MXN_TO_USD = 0.05;
      const salesMonthTotal = salesMonthUSD + (salesMonthMXN * MXN_TO_USD);
      const salesTodayTotal = salesTodayUSD + (salesTodayMXN * MXN_TO_USD);
      const refundsMonthTotal = refundsMonthUSD + (refundsMonthMXN * MXN_TO_USD);
      
      // NET Revenue = Gross - Refunds
      const netRevenueMonthUSD = salesMonthUSD - refundsMonthUSD;
      const netRevenueMonthMXN = salesMonthMXN - refundsMonthMXN;
      const netRevenueMonthTotal = salesMonthTotal - refundsMonthTotal;

      // Fetch failed transactions for recovery list (EXCLUDE paid/succeeded)
      // OPTIMIZATION: Limit to 500 to prevent timeout
      const { data: failedTransactions } = await supabase
        .from('transactions')
        .select('customer_email, amount, source, failure_code')
        .or('status.eq.failed,failure_code.in.(requires_payment_method,requires_action,requires_confirmation)')
        .order('stripe_created_at', { ascending: false })
        .limit(500);

      // Deduplicate failed transactions by email
      const failedByEmail = new Map<string, { amount: number; source: string }>();
      for (const tx of failedTransactions || []) {
        if (!tx.customer_email) continue;
        const existing = failedByEmail.get(tx.customer_email) || { amount: 0, source: tx.source || 'unknown' };
        // Amount is in cents, convert to dollars for display
        existing.amount += tx.amount / 100;
        if (tx.source && existing.source !== tx.source) {
          existing.source = 'stripe/paypal';
        }
        failedByEmail.set(tx.customer_email, existing);
      }

      // Get client details for recovery list
      const failedEmails = Array.from(failedByEmail.keys());
      let recoveryList: DashboardMetrics['recoveryList'] = [];

      if (failedEmails.length > 0) {
        const { data: clients } = await supabase
          .from('clients')
          .select('email, full_name, phone, customer_metadata')
          .in('email', failedEmails.slice(0, 100));

        for (const client of clients || []) {
          if (client.email) {
            const failed = failedByEmail.get(client.email);
            if (failed) {
              // Extract recovery_status from customer_metadata JSONB
              const metadata = client.customer_metadata as Record<string, unknown> | null;
              const recovery_status = metadata?.recovery_status as 'pending' | 'contacted' | 'paid' | 'lost' | undefined;
              
              recoveryList.push({
                email: client.email,
                full_name: client.full_name,
                phone: client.phone,
                amount: failed.amount,
                source: failed.source,
                recovery_status
              });
            }
          }
        }

        // Add any failed emails without client records
        for (const [email, data] of failedByEmail) {
          if (!recoveryList.find(r => r.email === email) && recoveryList.length < 100) {
            recoveryList.push({
              email,
              full_name: null,
              phone: null,
              amount: data.amount,
              source: data.source
            });
          }
        }
      }

      // Sort by amount descending
      recoveryList.sort((a, b) => b.amount - a.amount);

      // Fetch lifecycle stage counts from clients table
      // OPTIMIZATION: Use count queries instead of fetching all rows
      const [
        { count: leadCount },
        { count: trialCount },
        { count: customerCount },
        { count: churnCount },
        { count: convertedCount }
      ] = await Promise.all([
        supabase.from('clients').select('*', { count: 'exact', head: true }).eq('lifecycle_stage', 'LEAD'),
        supabase.from('clients').select('*', { count: 'exact', head: true }).eq('lifecycle_stage', 'TRIAL'),
        supabase.from('clients').select('*', { count: 'exact', head: true }).eq('lifecycle_stage', 'CUSTOMER'),
        supabase.from('clients').select('*', { count: 'exact', head: true }).eq('lifecycle_stage', 'CHURN'),
        supabase.from('clients').select('*', { count: 'exact', head: true }).not('converted_at', 'is', null),
      ]);
      
      // Use counts from parallel queries
      const finalLeadCount = leadCount || 0;
      const finalTrialCount = trialCount || 0;
      const finalCustomerCount = customerCount || 0;
      const finalChurnCount = churnCount || 0;
      const finalConvertedCount = convertedCount || 0;
      const conversionRate = finalTrialCount > 0 ? (finalConvertedCount / finalTrialCount) * 100 : 0;

      setMetrics({
        salesTodayUSD,
        salesTodayMXN,
        salesTodayTotal,
        salesMonthUSD,
        salesMonthMXN,
        salesMonthTotal,
        refundsMonthUSD,
        refundsMonthMXN,
        refundsMonthTotal,
        netRevenueMonthUSD,
        netRevenueMonthMXN,
        netRevenueMonthTotal,
        conversionRate,
        trialCount: finalTrialCount,
        convertedCount: finalConvertedCount,
        churnCount: finalChurnCount,
        recoveryList,
        leadCount: finalLeadCount,
        customerCount: finalCustomerCount
      });
    } catch (error) {
      console.error('Error fetching metrics:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();

    // OPTIMIZATION: Debounce realtime changes to prevent excessive refetches
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('🔄 Transaction change detected, refreshing metrics...');
        fetchMetrics();
      }, 3000); // 3 second debounce
    };

    // Subscribe to realtime changes for automatic updates
    const channel = supabase
      .channel('metrics-realtime')
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'transactions' },
        debouncedFetch
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'transactions' },
        debouncedFetch
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [fetchMetrics]);

  return { metrics, isLoading, refetch: fetchMetrics };
}
