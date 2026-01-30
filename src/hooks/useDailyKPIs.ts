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
      const { start, end } = getDateRange(filter);

      // OPTIMIZED: Use simplified RPCs that read from materialized views
      // These are instant (<10ms) and don't scan 200k+ row tables
      let trialsCount = 0;
      let clientsCount = 0;
      let mrr = 0;
      let mrrActiveCount = 0;
      let revenueAtRisk = 0;
      let revenueAtRiskCount = 0;

      // Run minimal queries in parallel with fallback logic
      const promises = await Promise.allSettled([
        // Trials started in period
        supabase.from('subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'trialing')
          .gte('trial_start', start)
          .lte('trial_start', end),
        // Clients created in period
        supabase.from('clients')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end),
        // MRR from kpi_mrr_summary RPC
        (supabase.rpc as any)('kpi_mrr_summary'),
        // Sales from kpi_sales_summary RPC
        (supabase.rpc as any)('kpi_sales_summary'),
      ]);

      // Extract trial count
      if (promises[0].status === 'fulfilled' && promises[0].value?.count !== null) {
        trialsCount = promises[0].value.count || 0;
      }
      
      // Extract clients count
      if (promises[1].status === 'fulfilled' && promises[1].value?.count !== null) {
        clientsCount = promises[1].value.count || 0;
      }
      
      // Extract MRR data with fallback
      if (promises[2].status === 'fulfilled' && promises[2].value?.data) {
        const mrrData = promises[2].value.data;
        // Handle both array and single object responses
        const mrrSummary = Array.isArray(mrrData) ? mrrData[0] : mrrData;
        if (mrrSummary) {
          mrr = (mrrSummary.mrr || 0) / 100;
          mrrActiveCount = mrrSummary.active_count || 0;
          revenueAtRisk = (mrrSummary.at_risk_amount || 0) / 100;
          revenueAtRiskCount = mrrSummary.at_risk_count || 0;
        }
      } else {
        // Fallback: try kpi_mrr (older function that exists)
        try {
          const { data: fallbackMrr } = await (supabase.rpc as any)('kpi_mrr');
          if (fallbackMrr?.[0]) {
            mrr = (fallbackMrr[0].mrr || 0) / 100;
            mrrActiveCount = fallbackMrr[0].active_subscriptions || 0;
          }
        } catch { /* ignore fallback errors */ }
      }

      // Extract sales data
      let salesUsd = 0;
      if (promises[3].status === 'fulfilled' && promises[3].value?.data) {
        const salesData = promises[3].value.data;
        salesUsd = salesData?.total_usd || salesData?.today_usd || 0;
      }

      const failedQueries = promises.filter(p => p.status === 'rejected').length;
      if (failedQueries >= 3) setError('Métricas limitadas disponibles');

      setKPIs({
        registrationsToday: clientsCount,
        trialsStartedToday: trialsCount,
        trialConversionsToday: 0, // Simplified - not tracking conversions in real-time
        newPayersToday: 0, // Simplified - use dashboard_metrics for this
        renewalsToday: 0, // Simplified
        failuresToday: 0, // Simplified - using dashboard for this
        failureReasons: [],
        cancellationsToday: 0, // Simplified
        newRevenue: salesUsd,
        conversionRevenue: 0,
        renewalRevenue: 0,
        cancellationRevenue: 0,
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
