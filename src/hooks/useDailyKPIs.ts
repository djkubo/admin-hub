import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

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

function getDateRange(filter: TimeFilter): { start: string; end: string; rangeParam: string } {
  const now = new Date();
  const endISO = now.toISOString();
  let rangeParam: string = filter;
  let startISO: string;

  switch (filter) {
    case 'today': startISO = endISO; break;
    case '7d': startISO = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(); break;
    case 'month': startISO = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); break;
    case 'all': startISO = new Date(now.getFullYear() - 10, 0, 1).toISOString(); break;
    default: startISO = endISO; rangeParam = 'today';
  }
  return { start: startISO, end: endISO, rangeParam };
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
        supabase.rpc('kpi_new_customers', { p_range: rangeParam, p_start_date: start.split('T')[0], p_end_date: end.split('T')[0] }),
        supabase.rpc('kpi_sales', { p_range: rangeParam, p_start_date: start.split('T')[0], p_end_date: end.split('T')[0] }),
        supabase.rpc('kpi_failed_payments', { p_range: rangeParam }),
        supabase.rpc('kpi_cancellations', { p_range: rangeParam }),
        supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'trialing').gte('created_at', start).lte('created_at', end),
        supabase.rpc('kpi_trial_to_paid', { p_range: rangeParam }),
        supabase.from('clients').select('id', { count: 'exact', head: true }).gte('created_at', start).lte('created_at', end)
      ]);

      // Extract results safely
      if (promises[0].status === 'fulfilled' && promises[0].value?.data) newCustomers = promises[0].value.data;
      if (promises[1].status === 'fulfilled' && promises[1].value?.data) sales = promises[1].value.data;
      if (promises[2].status === 'fulfilled' && promises[2].value?.data) failed = promises[2].value.data;
      if (promises[3].status === 'fulfilled' && promises[3].value?.data) cancellations = promises[3].value.data;
      if (promises[4].status === 'fulfilled' && promises[4].value?.count) trialsCount = promises[4].value.count;
      if (promises[5].status === 'fulfilled' && promises[5].value?.data) trialConversions = promises[5].value.data;
      if (promises[6].status === 'fulfilled' && promises[6].value?.count) clientsCount = promises[6].value.count;

      const failedQueries = promises.filter(p => p.status === 'rejected').length;
      if (failedQueries > 0) setError(`${failedQueries} métricas no cargaron`);

      // Aggregate
      const usdNew = newCustomers.find(r => r.currency?.toLowerCase() === 'usd') || { new_customer_count: 0, total_revenue: 0 };
      const usdSales = sales.find(r => r.currency?.toLowerCase() === 'usd') || { total_amount: 0, transaction_count: 0 };
      const usdFailed = failed.find(r => r.currency?.toLowerCase() === 'usd') || { failed_count: 0 };
      const usdCancel = cancellations.find(r => r.currency?.toLowerCase() === 'usd') || { cancellation_count: 0 };
      const trialConv = trialConversions[0] || { conversion_count: 0, total_revenue: 0 };

      const renewalsCount = Math.max(0, usdSales.transaction_count - usdNew.new_customer_count - trialConv.conversion_count);
      const newRevenue = usdNew.total_revenue / 100;
      const conversionRevenue = trialConv.total_revenue / 100;
      const renewalRevenue = Math.max(0, usdSales.total_amount / 100 - newRevenue - conversionRevenue);

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
      });
    } catch (err) {
      console.error('Error fetching KPIs:', err);
      setError('Error cargando métricas');
      setKPIs(defaultKPIs);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchKPIs();
    const channel = supabase.channel('kpis-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, () => fetchKPIs())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchKPIs]);

  return { kpis, isLoading, error, refetch: fetchKPIs };
}
