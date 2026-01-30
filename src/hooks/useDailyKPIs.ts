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

export function useDailyKPIs(filter: TimeFilter = 'today') {
  const [kpis, setKPIs] = useState<DailyKPIs>(defaultKPIs);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchKPIs = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { start, end, rangeParam } = getDateRange(filter);
      const startDateOnly = start.split('T')[0];
      const endDateOnly = end.split('T')[0];

      // Fetch each query separately with error handling
      let newCustomers: { new_customer_count: number; total_revenue: number; currency: string }[] = [];
      let sales: { total_amount: number; transaction_count: number; currency: string }[] = [];
      let failed: { failed_count: number; at_risk_amount: number; currency: string }[] = [];
      let cancellations: { cancellation_count: number; lost_mrr: number; currency: string }[] = [];
      let trialConversions: { conversion_count: number; total_revenue: number }[] = [];
      let trialsCount = 0;
      let clientsCount = 0;

      // Run in parallel but catch individual errors
      const promises = await Promise.allSettled([
        supabase.rpc('kpi_new_customers', { p_range: rangeParam, p_start_date: startDateOnly, p_end_date: endDateOnly }),
        supabase.rpc('kpi_sales', { p_range: rangeParam, p_start_date: startDateOnly, p_end_date: endDateOnly }),
        supabase.rpc('kpi_failed_payments', { p_range: rangeParam }),
        supabase.rpc('kpi_cancellations', { p_range: rangeParam }),
        // FIX: Use trial_start instead of created_at for trials count
        supabase.from('subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'trialing')
          .gte('trial_start', start)
          .lte('trial_start', end),
        supabase.rpc('kpi_trial_to_paid', { p_range: rangeParam }),
        supabase.from('clients')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end),
        // OPTIMIZED: Use server-side RPC for MRR aggregation (no limits needed)
        // Cast to any to bypass TypeScript until types are regenerated
        (supabase.rpc as any)('kpi_mrr_summary'),
      ]);

      // Extract results safely
      if (promises[0].status === 'fulfilled' && promises[0].value?.data) newCustomers = promises[0].value.data;
      if (promises[1].status === 'fulfilled' && promises[1].value?.data) sales = promises[1].value.data;
      if (promises[2].status === 'fulfilled' && promises[2].value?.data) failed = promises[2].value.data;
      if (promises[3].status === 'fulfilled' && promises[3].value?.data) cancellations = promises[3].value.data;
      if (promises[4].status === 'fulfilled' && promises[4].value?.count !== null) trialsCount = promises[4].value.count || 0;
      if (promises[5].status === 'fulfilled' && promises[5].value?.data) trialConversions = promises[5].value.data;
      if (promises[6].status === 'fulfilled' && promises[6].value?.count !== null) clientsCount = promises[6].value.count || 0;
      
      // OPTIMIZED: Extract MRR data from server-side RPC (100% accurate)
      let mrr = 0;
      let mrrActiveCount = 0;
      let revenueAtRisk = 0;
      let revenueAtRiskCount = 0;
      
      if (promises[7].status === 'fulfilled' && promises[7].value?.data) {
        const mrrSummary = promises[7].value.data[0];
        if (mrrSummary) {
          mrr = (mrrSummary.mrr || 0) / 100;
          mrrActiveCount = mrrSummary.active_count || 0;
          revenueAtRisk = (mrrSummary.at_risk_amount || 0) / 100;
          revenueAtRiskCount = mrrSummary.at_risk_count || 0;
        }
      }

      const failedQueries = promises.filter(p => p.status === 'rejected').length;
      if (failedQueries > 0) setError(`${failedQueries} métricas no cargaron`);

      // Aggregate - prioritize USD
      const usdNew = newCustomers.find(r => r.currency?.toLowerCase() === 'usd') || { new_customer_count: 0, total_revenue: 0 };
      const usdSales = sales.find(r => r.currency?.toLowerCase() === 'usd') || { total_amount: 0, transaction_count: 0 };
      const usdFailed = failed.find(r => r.currency?.toLowerCase() === 'usd') || { failed_count: 0 };
      const usdCancel = cancellations.find(r => r.currency?.toLowerCase() === 'usd') || { cancellation_count: 0, lost_mrr: 0 };
      const trialConv = trialConversions[0] || { conversion_count: 0, total_revenue: 0 };

      const renewalsCount = Math.max(0, usdSales.transaction_count - usdNew.new_customer_count - trialConv.conversion_count);
      const newRevenue = usdNew.total_revenue / 100;
      const conversionRevenue = trialConv.total_revenue / 100;
      const renewalRevenue = Math.max(0, usdSales.total_amount / 100 - newRevenue - conversionRevenue);
      const cancellationRevenue = (usdCancel.lost_mrr || 0) / 100;

      setKPIs({
        registrationsToday: clientsCount,
        trialsStartedToday: trialsCount,
        trialConversionsToday: trialConv.conversion_count,
        newPayersToday: usdNew.new_customer_count,
        renewalsToday: renewalsCount,
        failuresToday: usdFailed.failed_count,
        failureReasons: [],
        cancellationsToday: usdCancel.cancellation_count,
        newRevenue,
        conversionRevenue,
        renewalRevenue,
        cancellationRevenue,
        mrr,
        mrrActiveCount,
        revenueAtRisk,
        revenueAtRiskCount,
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
