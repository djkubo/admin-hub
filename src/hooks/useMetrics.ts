import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface DashboardMetrics {
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
}

const defaultMetrics: DashboardMetrics = {
  salesMonthUSD: 0,
  salesMonthMXN: 0,
  salesMonthTotal: 0,
  conversionRate: 0,
  trialCount: 0,
  convertedCount: 0,
  churnCount: 0,
  recoveryList: []
};

export function useMetrics() {
  const [metrics, setMetrics] = useState<DashboardMetrics>(defaultMetrics);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      // Fetch monthly sales from transactions table
      const { data: monthlyTransactions } = await supabase
        .from('transactions')
        .select('amount, currency, status')
        .gte('stripe_created_at', firstDayOfMonth.toISOString())
        .in('status', ['succeeded', 'paid']);

      let salesMonthUSD = 0;
      let salesMonthMXN = 0;

      // CRITICAL FIX #1: All amounts are stored in CENTS, divide by 100 for display
      for (const tx of monthlyTransactions || []) {
        const amountInCurrency = tx.amount / 100;
        if (tx.currency?.toLowerCase() === 'mxn') {
          salesMonthMXN += amountInCurrency;
        } else {
          salesMonthUSD += amountInCurrency;
        }
      }

      const MXN_TO_USD = 0.05;
      const salesMonthTotal = salesMonthUSD + (salesMonthMXN * MXN_TO_USD);

      // Fetch failed transactions for recovery list
      const { data: failedTransactions } = await supabase
        .from('transactions')
        .select('customer_email, amount, source, failure_code')
        .or('status.eq.failed,failure_code.in.(requires_payment_method,requires_action,requires_confirmation)');

      // Deduplicate failed transactions by email
      const failedByEmail = new Map<string, { amount: number; source: string }>();
      for (const tx of failedTransactions || []) {
        if (!tx.customer_email) continue;
        const existing = failedByEmail.get(tx.customer_email) || { amount: 0, source: tx.source || 'unknown' };
        // CRITICAL FIX #1: Amount is in cents, convert to dollars for display
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

      // CRITICAL FIX #4: Fetch unique trial/converted counts from clients table
      const { data: clientsData } = await supabase
        .from('clients')
        .select('email, status, trial_started_at, converted_at');
      
      // Count unique emails with trial
      const trialEmails = new Set<string>();
      const convertedEmails = new Set<string>();
      
      for (const client of clientsData || []) {
        if (client.trial_started_at && client.email) {
          trialEmails.add(client.email);
        }
        if (client.converted_at && client.email) {
          convertedEmails.add(client.email);
        }
      }
      
      const trialCount = trialEmails.size;
      const convertedCount = convertedEmails.size;
      const conversionRate = trialCount > 0 ? (convertedCount / trialCount) * 100 : 0;

      // Churn count from clients
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { count: churnCount } = await supabase
        .from('clients')
        .select('*', { count: 'exact', head: true })
        .in('status', ['inactive', 'Canceled', 'Expired', 'Churned']);

      setMetrics({
        salesMonthUSD,
        salesMonthMXN,
        salesMonthTotal,
        conversionRate,
        trialCount,
        convertedCount,
        churnCount: churnCount || 0,
        recoveryList
      });
    } catch (error) {
      console.error('Error fetching metrics:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  return { metrics, isLoading, refetch: fetchMetrics };
}
