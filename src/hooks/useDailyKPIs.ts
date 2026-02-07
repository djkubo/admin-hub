import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, endOfDay, subDays, subMonths, subYears } from 'date-fns';

export type TimeFilter = 'today' | '7d' | 'month' | 'all';

export interface MoneyByCurrency {
  usd: number;
  mxn: number;
}

export interface DailyKPIs {
  registrationsToday: number;
  trialsStartedToday: number;
  trialConversionsToday: number;
  trialConversionRate: number;
  newPayersToday: number;
  renewalsToday: number;
  failuresToday: number;
  failureReasons: Array<{ reason: string; count: number }>;
  cancellationsToday: number;
  // Sales (cash collected) in the selected range
  grossSales: MoneyByCurrency;
  refunds: MoneyByCurrency;
  netSales: MoneyByCurrency;
  // Revenue by segment
  newCustomerRevenue: MoneyByCurrency;
  renewalRevenue: MoneyByCurrency;
  trialConversionRevenue: number; // subscriptions-based (no currency breakdown)
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
  trialConversionRate: 0,
  newPayersToday: 0,
  renewalsToday: 0,
  failuresToday: 0,
  failureReasons: [],
  cancellationsToday: 0,
  grossSales: { usd: 0, mxn: 0 },
  refunds: { usd: 0, mxn: 0 },
  netSales: { usd: 0, mxn: 0 },
  newCustomerRevenue: { usd: 0, mxn: 0 },
  renewalRevenue: { usd: 0, mxn: 0 },
  trialConversionRevenue: 0,
  mrr: 0,
  mrrActiveCount: 0,
  revenueAtRisk: 0,
  revenueAtRiskCount: 0,
};

function getDateRange(filter: TimeFilter): { start: string; end: string; rangeParam: string } {
  const now = new Date();
  
  let startDate: Date;
  const endDate = endOfDay(now);
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

async function countClients(start: string, end: string): Promise<number> {
  const { count } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', start)
    .lte('created_at', end);
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

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeMoneyByCurrency(rows: Array<Record<string, unknown>> | null | undefined, amountKey: string): MoneyByCurrency {
  const money: MoneyByCurrency = { usd: 0, mxn: 0 };
  for (const row of rows || []) {
    const currencyRaw = row.currency;
    const currency = typeof currencyRaw === 'string' ? currencyRaw.toLowerCase() : 'usd';
    const amountCents = toNumber(row[amountKey]);
    if (currency === 'mxn') money.mxn += amountCents / 100;
    else money.usd += amountCents / 100;
  }
  return money;
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

      // Prefer deterministic, timezone-aware server KPIs.
      // Each RPC has a safe fallback to keep the dashboard usable even if a function is missing.
      const [
        clientsCount,
        mrrData,
        salesResult,
        refundsResult,
        newCustomersResult,
        renewalsResult,
        trialToPaidResult,
        cancellationsResult,
        trialsStartedResult,
      ] = await Promise.all([
        countClients(start, end),
        getMrrSummary(),
        // Sales (gross)
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_sales' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            return Array.isArray(data) ? (data as any[]) : data ? [data as any] : [];
          } catch {
            // Fallback: limited client-side aggregation (avoid huge scans)
            const { data } = await supabase
              .from('transactions')
              .select('amount, currency')
              .in('status', ['paid', 'succeeded'])
              .gte('stripe_created_at', start)
              .lte('stripe_created_at', end)
              .limit(5000);
            const buckets: Record<string, number> = {};
            for (const row of data || []) {
              const c = (row.currency || 'usd').toLowerCase();
              buckets[c] = (buckets[c] || 0) + (row.amount || 0);
            }
            return Object.entries(buckets).map(([currency, total_amount]) => ({ currency, total_amount }));
          }
        })(),
        // Refunds
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_refunds' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            return Array.isArray(data) ? (data as any[]) : data ? [data as any] : [];
          } catch {
            const { data } = await supabase
              .from('transactions')
              .select('amount, currency')
              .eq('status', 'refunded')
              .gte('stripe_created_at', start)
              .lte('stripe_created_at', end)
              .limit(5000);
            const buckets: Record<string, number> = {};
            for (const row of data || []) {
              const c = (row.currency || 'usd').toLowerCase();
              buckets[c] = (buckets[c] || 0) + Math.abs(row.amount || 0);
            }
            return Object.entries(buckets).map(([currency, refund_amount]) => ({ currency, refund_amount }));
          }
        })(),
        // New customers (first payment in range)
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_new_customers' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            return Array.isArray(data) ? (data as any[]) : data ? [data as any] : [];
          } catch {
            // Fallback: compute first payment per email (limited to 10k rows)
            const { data } = await supabase
              .from('transactions')
              .select('customer_email, currency, amount, stripe_created_at')
              .in('status', ['paid', 'succeeded'])
              .not('customer_email', 'is', null)
              .order('stripe_created_at', { ascending: true })
              .limit(10000);
            const firstByEmailCurrency = new Map<string, { currency: string; amount: number; createdAt: string }>();
            for (const row of data || []) {
              if (!row.customer_email || !row.stripe_created_at) continue;
              const email = row.customer_email.toLowerCase();
              const currency = (row.currency || 'usd').toLowerCase();
              const key = `${email}|${currency}`;
              if (!firstByEmailCurrency.has(key)) {
                firstByEmailCurrency.set(key, { currency, amount: row.amount || 0, createdAt: row.stripe_created_at });
              }
            }
            const buckets: Record<string, { count: number; revenue: number }> = {};
            const startMs = new Date(start).getTime();
            const endMs = new Date(end).getTime();
            for (const fp of firstByEmailCurrency.values()) {
              const ts = new Date(fp.createdAt).getTime();
              if (ts < startMs || ts > endMs) continue;
              buckets[fp.currency] ??= { count: 0, revenue: 0 };
              buckets[fp.currency].count += 1;
              buckets[fp.currency].revenue += fp.amount;
            }
            return Object.entries(buckets).map(([currency, v]) => ({
              currency,
              new_customer_count: v.count,
              total_revenue: v.revenue,
            }));
          }
        })(),
        // Renewals (payments by returning customers)
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_renewals' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            return Array.isArray(data) ? (data as any[]) : data ? [data as any] : [];
          } catch {
            // Fallback: classify renewals as payments after first payment per email
            const { data } = await supabase
              .from('transactions')
              .select('customer_email, currency, amount, stripe_created_at')
              .in('status', ['paid', 'succeeded'])
              .not('customer_email', 'is', null)
              .not('stripe_created_at', 'is', null)
              .order('stripe_created_at', { ascending: true })
              .limit(10000);
            const firstByEmail = new Map<string, string>();
            const renewals: Array<{ currency: string; amount: number; createdAt: string }> = [];
            for (const row of data || []) {
              const email = row.customer_email?.toLowerCase();
              if (!email || !row.stripe_created_at) continue;
              const currency = (row.currency || 'usd').toLowerCase();
              if (!firstByEmail.has(email)) firstByEmail.set(email, row.stripe_created_at);
              else renewals.push({ currency, amount: row.amount || 0, createdAt: row.stripe_created_at });
            }
            const startMs = new Date(start).getTime();
            const endMs = new Date(end).getTime();
            const buckets: Record<string, { count: number; revenue: number }> = {};
            for (const r of renewals) {
              const ts = new Date(r.createdAt).getTime();
              if (ts < startMs || ts > endMs) continue;
              buckets[r.currency] ??= { count: 0, revenue: 0 };
              buckets[r.currency].count += 1;
              buckets[r.currency].revenue += r.amount;
            }
            return Object.entries(buckets).map(([currency, v]) => ({
              currency,
              renewal_count: v.count,
              total_revenue: v.revenue,
            }));
          }
        })(),
        // Trial -> paid (subscriptions-based, deterministic)
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_trial_to_paid' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            const rows = Array.isArray(data) ? (data as any[]) : data ? [data as any] : [];
            return rows[0] || null;
          } catch {
            return null;
          }
        })(),
        // Cancellations
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_cancellations' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            return Array.isArray(data) ? (data as any[]) : data ? [data as any] : [];
          } catch {
            // Fallback: count canceled_at in range
            const { count } = await supabase
              .from('subscriptions')
              .select('id', { count: 'exact', head: true })
              .not('canceled_at', 'is', null)
              .gte('canceled_at', start)
              .lte('canceled_at', end);
            return [{ currency: 'usd', cancellation_count: count || 0, lost_mrr: 0 }];
          }
        })(),
        // Trials started
        (async () => {
          try {
            const { data, error: rpcError } = await supabase.rpc('kpi_trials_started' as any, { p_range: rangeParam });
            if (rpcError) throw rpcError;
            const row = Array.isArray(data) ? data[0] : data;
            return { trial_count: toNumber((row as any)?.trial_count) };
          } catch {
            const { count } = await supabase
              .from('subscriptions')
              .select('id', { count: 'exact', head: true })
              .not('trial_start', 'is', null)
              .gte('trial_start', start)
              .lte('trial_start', end);
            return { trial_count: count || 0 };
          }
        })(),
      ]);

      const grossSales = normalizeMoneyByCurrency(salesResult as any, 'total_amount');
      const refunds = normalizeMoneyByCurrency(refundsResult as any, 'refund_amount');
      const netSales: MoneyByCurrency = {
        usd: grossSales.usd - refunds.usd,
        mxn: grossSales.mxn - refunds.mxn,
      };

      const newCustomerRevenue = normalizeMoneyByCurrency(newCustomersResult as any, 'total_revenue');
      const newCustomersCount = (newCustomersResult as any[]).reduce((sum, r) => sum + toNumber(r.new_customer_count), 0);

      const renewalRevenue = normalizeMoneyByCurrency(renewalsResult as any, 'total_revenue');
      const renewalsCount = (renewalsResult as any[]).reduce((sum, r) => sum + toNumber(r.renewal_count), 0);

      const trialConversionsToday = toNumber((trialToPaidResult as any)?.conversion_count);
      const trialConversionRate = toNumber((trialToPaidResult as any)?.conversion_rate);
      const trialConversionRevenue = toNumber((trialToPaidResult as any)?.total_revenue) / 100;

      const cancellationsCount = (cancellationsResult as any[]).reduce((sum, r) => sum + toNumber(r.cancellation_count), 0);

      setKPIs({
        registrationsToday: clientsCount,
        trialsStartedToday: trialsStartedResult.trial_count,
        trialConversionsToday,
        trialConversionRate,
        newPayersToday: newCustomersCount,
        renewalsToday: renewalsCount,
        failuresToday: 0, // TODO: wire kpi_failed_payments + failure reasons if needed
        failureReasons: [],
        cancellationsToday: cancellationsCount,
        grossSales,
        refunds,
        netSales,
        newCustomerRevenue,
        renewalRevenue,
        trialConversionRevenue,
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
