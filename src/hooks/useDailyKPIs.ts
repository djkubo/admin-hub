import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, endOfDay, subDays, subMonths, subYears, format } from 'date-fns';

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
      const startDateOnly = format(new Date(start), 'yyyy-MM-dd');
      const endDateOnly = format(new Date(end), 'yyyy-MM-dd');

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
        // Also use proper date range (start to end of day)
        supabase.from('subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'trialing')
          .gte('trial_start', start)
          .lte('trial_start', end),
        supabase.rpc('kpi_trial_to_paid', { p_range: rangeParam }),
        supabase.from('clients')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end)
      ]);

      // Extract results safely
      if (promises[0].status === 'fulfilled' && promises[0].value?.data) newCustomers = promises[0].value.data;
      if (promises[1].status === 'fulfilled' && promises[1].value?.data) sales = promises[1].value.data;
      if (promises[2].status === 'fulfilled' && promises[2].value?.data) failed = promises[2].value.data;
      if (promises[3].status === 'fulfilled' && promises[3].value?.data) cancellations = promises[3].value.data;
      if (promises[4].status === 'fulfilled' && promises[4].value?.count !== null) trialsCount = promises[4].value.count || 0;
      if (promises[5].status === 'fulfilled' && promises[5].value?.data) trialConversions = promises[5].value.data;
      if (promises[6].status === 'fulfilled' && promises[6].value?.count !== null) clientsCount = promises[6].value.count || 0;

      const failedQueries = promises.filter(p => p.status === 'rejected').length;
      if (failedQueries > 0) setError(`${failedQueries} métricas no cargaron`);

      const MXN_TO_USD = 0.05;

      const sumByCurrency = <T extends { currency?: string | null }>(
        rows: T[],
        amountKey: keyof T,
      ) => rows.reduce((sum, row) => {
        const amount = Number(row[amountKey] ?? 0);
        const currency = row.currency?.toLowerCase();

        if (currency === 'mxn') {
          return sum + amount * MXN_TO_USD;
        }
        return sum + amount;
      }, 0);

      const sumCounts = <T,>(rows: T[], countKey: keyof T) =>
        rows.reduce((sum, row) => sum + Number(row[countKey] ?? 0), 0);

      // Aggregate across currencies (fallback to USD conversion for MXN)
      const totalNewCustomers = sumCounts(newCustomers, 'new_customer_count');
      const totalNewRevenue = sumByCurrency(newCustomers, 'total_revenue');
      const totalSalesCount = sumCounts(sales, 'transaction_count');
      const totalSalesAmount = sumByCurrency(sales, 'total_amount');
      const totalFailures = sumCounts(failed, 'failed_count');
      const totalCancellations = sumCounts(cancellations, 'cancellation_count');
      const totalCancellationRevenue = sumByCurrency(cancellations, 'lost_mrr');
      const trialConv = trialConversions[0] || { conversion_count: 0, total_revenue: 0 };

      const renewalsCount = Math.max(0, totalSalesCount - totalNewCustomers - trialConv.conversion_count);
      const newRevenue = totalNewRevenue / 100;
      const conversionRevenue = trialConv.total_revenue / 100;
      const renewalRevenue = Math.max(0, totalSalesAmount / 100 - newRevenue - conversionRevenue);
      const cancellationRevenue = totalCancellationRevenue / 100;

      setKPIs({
        registrationsToday: clientsCount,
        trialsStartedToday: trialsCount,
        trialConversionsToday: trialConv.conversion_count,
        newPayersToday: totalNewCustomers,
        renewalsToday: renewalsCount,
        failuresToday: totalFailures,
        failureReasons: [],
        cancellationsToday: totalCancellations,
        newRevenue,
        conversionRevenue,
        renewalRevenue,
        cancellationRevenue,
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

    // Subscribe to sync run completions instead of row-level inserts
    const channel = supabase.channel('kpis-sync-runs')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sync_runs' }, (payload) => {
        const status = (payload.new as { status?: string }).status;
        if (status === 'completed' || status === 'completed_with_errors') {
          fetchKPIs();
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchKPIs]);

  return { kpis, isLoading, error, refetch: fetchKPIs };
}
