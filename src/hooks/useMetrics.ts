import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface DashboardMetrics {
  // Today's sales
  salesTodayUSD: number;
  salesTodayMXN: number;
  salesTodayTotal: number;
  // Month's sales
  salesMonthUSD: number;
  salesMonthMXN: number;
  salesMonthTotal: number;
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
      
      // Fetch monthly sales - ONLY count 'succeeded' and 'paid' status
      const { data: monthlyTransactions } = await supabase
        .from('transactions')
        .select('amount, currency, status, stripe_created_at')
        .gte('stripe_created_at', firstDayOfMonth.toISOString())
        .in('status', ['succeeded', 'paid']); // ONLY paid transactions

      let salesMonthUSD = 0;
      let salesMonthMXN = 0;
      let salesTodayUSD = 0;
      let salesTodayMXN = 0;

      // All amounts stored in CENTS, divide by 100 for display
      for (const tx of monthlyTransactions || []) {
        const amountInCurrency = tx.amount / 100;
        const txDate = tx.stripe_created_at ? new Date(tx.stripe_created_at) : null;
        const isToday = txDate && txDate >= startOfTodayUTC;
        
        if (tx.currency?.toLowerCase() === 'mxn') {
          salesMonthMXN += amountInCurrency;
          if (isToday) salesTodayMXN += amountInCurrency;
        } else {
          salesMonthUSD += amountInCurrency;
          if (isToday) salesTodayUSD += amountInCurrency;
        }
      }

      const MXN_TO_USD = 0.05;
      const salesMonthTotal = salesMonthUSD + (salesMonthMXN * MXN_TO_USD);
      const salesTodayTotal = salesTodayUSD + (salesTodayMXN * MXN_TO_USD);

      // Fetch failed transactions for recovery list (EXCLUDE paid/succeeded)
      const { data: failedTransactions } = await supabase
        .from('transactions')
        .select('customer_email, amount, source, failure_code')
        .or('status.eq.failed,failure_code.in.(requires_payment_method,requires_action,requires_confirmation)');

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
          .select('email, full_name, phone')
          .in('email', failedEmails.slice(0, 100));

        for (const client of clients || []) {
          if (client.email) {
            const failed = failedByEmail.get(client.email);
            if (failed) {
              recoveryList.push({
                email: client.email,
                full_name: client.full_name,
                phone: client.phone,
                amount: failed.amount,
                source: failed.source
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
      const { data: clientsData } = await supabase
        .from('clients')
        .select('email, status, trial_started_at, converted_at, lifecycle_stage');
      
      // Count unique emails by lifecycle stage
      const trialEmails = new Set<string>();
      const convertedEmails = new Set<string>();
      let leadCount = 0;
      let customerCount = 0;
      let churnCount = 0;
      
      for (const client of clientsData || []) {
        if (!client.email) continue;
        
        const stage = client.lifecycle_stage as string;
        
        switch (stage) {
          case 'LEAD':
            leadCount++;
            break;
          case 'TRIAL':
            trialEmails.add(client.email);
            break;
          case 'CUSTOMER':
            customerCount++;
            if (client.converted_at) {
              convertedEmails.add(client.email);
            }
            break;
          case 'CHURN':
            churnCount++;
            break;
        }
        
        // Also track trial_started_at for conversion rate
        if (client.trial_started_at) {
          trialEmails.add(client.email);
        }
        if (client.converted_at) {
          convertedEmails.add(client.email);
        }
      }
      
      const trialCount = trialEmails.size;
      const convertedCount = convertedEmails.size;
      const conversionRate = trialCount > 0 ? (convertedCount / trialCount) * 100 : 0;

      setMetrics({
        salesTodayUSD,
        salesTodayMXN,
        salesTodayTotal,
        salesMonthUSD,
        salesMonthMXN,
        salesMonthTotal,
        conversionRate,
        trialCount,
        convertedCount,
        churnCount,
        recoveryList,
        leadCount,
        customerCount
      });
    } catch (error) {
      console.error('Error fetching metrics:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();

    // Subscribe to realtime changes for automatic updates
    const channel = supabase
      .channel('metrics-realtime')
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'transactions' },
        () => {
          console.log('🔄 New transaction detected, refreshing metrics...');
          fetchMetrics();
        }
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'transactions' },
        () => fetchMetrics()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchMetrics]);

  return { metrics, isLoading, refetch: fetchMetrics };
}
