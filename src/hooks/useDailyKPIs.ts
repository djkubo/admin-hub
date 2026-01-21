import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type TimeFilter = 'today' | '7d' | 'month' | 'all';

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

function getDateRange(filter: TimeFilter): { start: string; end: string; rangeParam: string } {
  const now = new Date();
  const endISO = now.toISOString();
  let startISO: string;
  // rangeParam must match the RPC function parameter values: 'today', '7d', 'month', 'all'
  let rangeParam: string;

  switch (filter) {
    case 'today':
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      startISO = todayStart.toISOString();
      rangeParam = 'today';
      break;
    case '7d':
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startISO = sevenDaysAgo.toISOString();
      rangeParam = '7d';
      break;
    case 'month':
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      startISO = monthStart.toISOString();
      rangeParam = 'month';
      break;
    case 'all':
      const tenYearsAgo = new Date(Date.UTC(now.getUTCFullYear() - 10, 0, 1));
      startISO = tenYearsAgo.toISOString();
      rangeParam = 'all';
      break;
    default:
      const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      startISO = defaultStart.toISOString();
      rangeParam = 'today';
  }

  console.log(`📊 KPI date range (${filter}): ${startISO} to ${endISO}, rangeParam: ${rangeParam}`);
  return { start: startISO, end: endISO, rangeParam };
}

export function useDailyKPIs(filter: TimeFilter = 'today') {
  const [kpis, setKPIs] = useState<DailyKPIs>(defaultKPIs);
  const [isLoading, setIsLoading] = useState(true);

  const fetchKPIs = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end, rangeParam } = getDateRange(filter);

      console.log(`🔍 Fetching KPIs for ${filter}: ${start} to ${end}`);

      // Parallel queries for efficiency
      const [
        newCustomersResult,
        salesResult,
        failedResult,
        cancellationsResult,
        trialsResult,
        trialConversionsResult,
        clientsResult
      ] = await Promise.all([
        // New customers (first-time payers) using RPC
        supabase.rpc('kpi_new_customers', { 
          p_range: rangeParam,
          p_start_date: start.split('T')[0],
          p_end_date: end.split('T')[0]
        }),
        // Total sales using RPC
        supabase.rpc('kpi_sales', {
          p_range: rangeParam,
          p_start_date: start.split('T')[0],
          p_end_date: end.split('T')[0]
        }),
        // Failed payments using RPC
        supabase.rpc('kpi_failed_payments', { p_range: rangeParam }),
        // Cancellations using RPC
        supabase.rpc('kpi_cancellations', { p_range: rangeParam }),
        // Trials started (subscriptions in trialing status created in range)
        supabase
          .from('subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'trialing')
          .gte('created_at', start)
          .lte('created_at', end),
        // Trial conversions using RPC
        supabase.rpc('kpi_trial_to_paid', { p_range: rangeParam }),
        // Client registrations in range
        supabase
          .from('clients')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end)
      ]);

      // Parse results with null safety
      const newCustomers = (newCustomersResult.data as Array<{
        new_customer_count: number;
        total_revenue: number;
        currency: string;
      }>) || [];
      
      const sales = (salesResult.data as Array<{
        total_amount: number;
        transaction_count: number;
        currency: string;
      }>) || [];
      
      const failed = (failedResult.data as Array<{
        failed_count: number;
        at_risk_amount: number;
        currency: string;
      }>) || [];
      
      const cancellations = (cancellationsResult.data as Array<{
        cancellation_count: number;
        lost_mrr: number;
        currency: string;
      }>) || [];
      
      const trialConversions = (trialConversionsResult.data as Array<{
        conversion_count: number;
        conversion_rate: number;
        total_revenue: number;
      }>) || [];

      // Aggregate by currency (prioritize USD)
      const usdNewCustomers = newCustomers.find(r => r.currency?.toLowerCase() === 'usd') || { new_customer_count: 0, total_revenue: 0 };
      const usdSales = sales.find(r => r.currency?.toLowerCase() === 'usd') || { total_amount: 0, transaction_count: 0 };
      const usdFailed = failed.find(r => r.currency?.toLowerCase() === 'usd') || { failed_count: 0, at_risk_amount: 0 };
      const usdCancellations = cancellations.find(r => r.currency?.toLowerCase() === 'usd') || { cancellation_count: 0, lost_mrr: 0 };
      const trialConv = trialConversions[0] || { conversion_count: 0, total_revenue: 0 };

      // Calculate renewals: total successful payments - new customers - trial conversions
      const totalSuccessfulPayments = usdSales.transaction_count;
      const newCustomerCount = usdNewCustomers.new_customer_count;
      const trialConversionCount = trialConv.conversion_count;
      const renewalsCount = Math.max(0, totalSuccessfulPayments - newCustomerCount - trialConversionCount);

      // Revenue breakdown (in cents, convert to dollars)
      const newRevenue = usdNewCustomers.total_revenue / 100;
      const conversionRevenue = trialConv.total_revenue / 100;
      const totalRevenueFromSales = usdSales.total_amount / 100;
      const renewalRevenue = Math.max(0, totalRevenueFromSales - newRevenue - conversionRevenue);

      // Get failure reasons from direct query (limited to avoid performance issues)
      const { data: failureData } = await supabase
        .from('transactions')
        .select('failure_code, failure_message')
        .eq('status', 'failed')
        .gte('stripe_created_at', start)
        .lte('stripe_created_at', end)
        .limit(500);

      const failureReasonsMap = new Map<string, number>();
      for (const tx of failureData || []) {
        const reason = tx.failure_code || tx.failure_message || 'unknown';
        failureReasonsMap.set(reason, (failureReasonsMap.get(reason) || 0) + 1);
      }

      const failureReasons = Array.from(failureReasonsMap.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const calculatedKPIs: DailyKPIs = {
        registrationsToday: clientsResult.count || 0,
        trialsStartedToday: trialsResult.count || 0,
        trialConversionsToday: trialConversionCount,
        newPayersToday: newCustomerCount,
        renewalsToday: renewalsCount,
        failuresToday: usdFailed.failed_count,
        failureReasons,
        cancellationsToday: usdCancellations.cancellation_count,
        newRevenue,
        conversionRevenue,
        renewalRevenue,
      };

      console.log('✅ Calculated KPIs from RPCs:', {
        filter,
        newPayersToday: newCustomerCount,
        renewalsToday: renewalsCount,
        trialConversionsToday: trialConversionCount,
        failuresToday: usdFailed.failed_count,
        totalTransactions: totalSuccessfulPayments,
        newRevenue,
        renewalRevenue,
        conversionRevenue,
        total: totalRevenueFromSales
      });

      setKPIs(calculatedKPIs);
    } catch (error) {
      console.error('❌ Error fetching daily KPIs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchKPIs();
  }, [fetchKPIs]);

  return { kpis, isLoading, refetch: fetchKPIs };
}
