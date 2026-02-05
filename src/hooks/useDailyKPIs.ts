import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, endOfDay, subDays, subMonths, subYears } from 'date-fns';

export type TimeFilter = 'today' | '7d' | 'month' | 'all';

export interface DailyKPIs {
  registrationsToday: number;
  trialsStartedToday: number;
  trialConversionsToday: number;
  newPayersToday: number;
  renewalsToday: number;
  failuresToday: number;
  failureReasons: Array<{ reason: string; count: number }>;
  cancellationsToday: number;
  newRevenue: number;
  conversionRevenue: number;
  renewalRevenue: number;
  cancellationRevenue: number;
  // NEW: Real-time MRR and Revenue at Risk
  mrr: number;
  mrrActiveCount: number;
  revenueAtRisk: number;
  revenueAtRiskCount: number;
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
  cancellationRevenue: 0,
  mrr: 0,
  mrrActiveCount: 0,
  revenueAtRisk: 0,
  revenueAtRiskCount: 0,
};

function getDateRange(filter: TimeFilter): { start: string; end: string; rangeParam: string } {
  const now = new Date();
  
  let startDate: Date;
  let endDate = endOfDay(now);
  let rangeParam: string = filter;

  switch (filter) {
    case 'today':
      // Use start of day to end of day for "today" (FIX for trials going to 0)
      startDate = startOfDay(now);
      break;
    case '7d':
      startDate = startOfDay(subDays(now, 7));
      break;
    case 'month':
      startDate = startOfDay(subMonths(now, 1));
      break;
    case 'all':
      startDate = subYears(now, 10);
      break;
    default:
      startDate = startOfDay(now);
      rangeParam = 'today';
  }

  return { 
    start: startDate.toISOString(), 
    end: endDate.toISOString(), 
    rangeParam 
  };
}

// Helper functions to avoid TypeScript deep instantiation errors
async function countTrials(start: string, end: string): Promise<number> {
  const { count } = await supabase
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'trialing')
    .gte('trial_start', start)
    .lte('trial_start', end);
  return count || 0;
}

async function countClients(start: string, end: string): Promise<number> {
  const { count } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', start)
    .lte('created_at', end);
  return count || 0;
}

async function getSalesTotal(start: string, end: string): Promise<number> {
  const { data } = await supabase
    .from('transactions')
    .select('amount')
    .in('status', ['succeeded', 'paid'])
    .gte('stripe_created_at', start)
    .lte('stripe_created_at', end);
  
  if (!data || !Array.isArray(data)) return 0;
  const totalCents = data.reduce((sum, tx) => sum + ((tx as any).amount || 0), 0);
  return totalCents / 100;
}

async function getNewPayersData(start: string, end: string): Promise<{ count: number; revenue: number }> {
  // Fetch new subscriptions with amount for both count and revenue
  const result = await (supabase
    .from('transactions')
    .select('id, amount')
    .in('status', ['succeeded', 'paid']) as any)
    .eq('billing_reason', 'subscription_create')
    .gte('stripe_created_at', start)
    .lte('stripe_created_at', end);
  
  const data = result?.data || [];
  const count = data.length;
  const revenue = data.reduce((sum: number, tx: any) => sum + (tx.amount || 0), 0) / 100;
  return { count, revenue };
}

async function getRenewalsData(start: string, end: string): Promise<{ count: number; revenue: number }> {
  // Fetch renewals with amount for both count and revenue
  const result = await (supabase
    .from('transactions')
    .select('id, amount')
    .in('status', ['succeeded', 'paid']) as any)
    .eq('billing_reason', 'subscription_cycle')
    .gte('stripe_created_at', start)
    .lte('stripe_created_at', end);
  
  const data = result?.data || [];
  const count = data.length;
  const revenue = data.reduce((sum: number, tx: any) => sum + (tx.amount || 0), 0) / 100;
  return { count, revenue };
}

async function getTrialConversionsData(start: string, end: string): Promise<{ count: number; revenue: number }> {
  // Trial conversions are first payments after trial period
  const result = await (supabase
    .from('transactions')
    .select('id, amount')
    .in('status', ['succeeded', 'paid']) as any)
    .eq('payment_type', 'trial_conversion')
    .gte('stripe_created_at', start)
    .lte('stripe_created_at', end);
  
  const data = result?.data || [];
  const count = data.length;
  const revenue = data.reduce((sum: number, tx: any) => sum + (tx.amount || 0), 0) / 100;
  return { count, revenue };
}

async function countCancellations(start: string, end: string): Promise<number> {
  const { count } = await supabase
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .not('canceled_at', 'is', null)
    .gte('canceled_at', start)
    .lte('canceled_at', end);
  return count || 0;
}

async function getMrrSummary(): Promise<{ mrr: number; mrrActiveCount: number; revenueAtRisk: number; revenueAtRiskCount: number }> {
  try {
    const { data } = await (supabase.rpc as any)('kpi_mrr_summary');
    if (data) {
      const mrrSummary = Array.isArray(data) ? data[0] : data;
      if (mrrSummary) {
        return {
          mrr: (mrrSummary.mrr || 0) / 100,
          mrrActiveCount: mrrSummary.active_count || 0,
          revenueAtRisk: (mrrSummary.at_risk_amount || 0) / 100,
          revenueAtRiskCount: mrrSummary.at_risk_count || 0,
        };
      }
    }
  } catch {
    // Try fallback
    try {
      const { data: fallbackMrr } = await (supabase.rpc as any)('kpi_mrr');
      if (fallbackMrr?.[0]) {
        return {
          mrr: (fallbackMrr[0].mrr || 0) / 100,
          mrrActiveCount: fallbackMrr[0].active_subscriptions || 0,
          revenueAtRisk: 0,
          revenueAtRiskCount: 0,
        };
      }
    } catch { /* ignore */ }
  }
  return { mrr: 0, mrrActiveCount: 0, revenueAtRisk: 0, revenueAtRiskCount: 0 };
}

export function useDailyKPIs(filter: TimeFilter = 'today') {
  const [kpis, setKPIs] = useState<DailyKPIs>(defaultKPIs);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchKPIs = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { start, end } = getDateRange(filter);

      // Run all queries in parallel using helper functions
      const [
        trialsCount,
        clientsCount,
        mrrData,
        salesUsd,
        newPayersData,
        renewalsData,
        trialConversionsData,
        cancellationsCount,
      ] = await Promise.all([
        countTrials(start, end),
        countClients(start, end),
        getMrrSummary(),
        getSalesTotal(start, end),
        getNewPayersData(start, end),
        getRenewalsData(start, end),
        getTrialConversionsData(start, end),
        countCancellations(start, end),
      ]);

      setKPIs({
        registrationsToday: clientsCount,
        trialsStartedToday: trialsCount,
        trialConversionsToday: trialConversionsData.count,
        newPayersToday: newPayersData.count,
        renewalsToday: renewalsData.count,
        failuresToday: 0, // Simplified - using dashboard for this
        failureReasons: [],
        cancellationsToday: cancellationsCount,
        newRevenue: salesUsd,
        conversionRevenue: trialConversionsData.revenue,
        renewalRevenue: renewalsData.revenue,
        cancellationRevenue: 0,
        mrr: mrrData.mrr,
        mrrActiveCount: mrrData.mrrActiveCount,
        revenueAtRisk: mrrData.revenueAtRisk,
        revenueAtRiskCount: mrrData.revenueAtRiskCount,
      });
    } catch (err) {
      console.error('Error fetching KPIs:', err);
      setError('Error cargando métricas');
      setKPIs(defaultKPIs);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  // Initial fetch
  useEffect(() => {
    fetchKPIs();
  }, [fetchKPIs]);
  
  // OPTIMIZATION: Use polling instead of Realtime to avoid AbortError issues
  // Realtime was causing "signal is aborted without reason" errors
  useEffect(() => {
    const interval = setInterval(() => {
      fetchKPIs();
    }, 60000); // Refresh every 60 seconds
    
    return () => clearInterval(interval);
  }, [fetchKPIs]);

  return { kpis, isLoading, error, refetch: fetchKPIs };
}
