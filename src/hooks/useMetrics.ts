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
      const { data, error } = await supabase.rpc('dashboard_metrics');
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      const salesTodayUSD = Number(row?.sales_today_usd ?? 0) / 100;
      const salesTodayMXN = Number(row?.sales_today_mxn ?? 0) / 100;
      const salesMonthUSD = Number(row?.sales_month_usd ?? 0) / 100;
      const salesMonthMXN = Number(row?.sales_month_mxn ?? 0) / 100;
      const MXN_TO_USD = 0.05;
      const salesTodayTotal = salesTodayUSD + salesTodayMXN * MXN_TO_USD;
      const salesMonthTotal = salesMonthUSD + salesMonthMXN * MXN_TO_USD;

      const trialCount = Number(row?.trial_count ?? 0);
      const convertedCount = Number(row?.converted_count ?? 0);
      const conversionRate = trialCount > 0 ? (convertedCount / trialCount) * 100 : 0;

      const recoveryList = (row?.recovery_list || []) as DashboardMetrics['recoveryList'];

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
        churnCount: Number(row?.churn_count ?? 0),
        recoveryList,
        leadCount: Number(row?.lead_count ?? 0),
        customerCount: Number(row?.customer_count ?? 0),
      });
    } catch (error) {
      console.error('Error fetching metrics:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();

    // Subscribe to sync run completions instead of row-level inserts
    const channel = supabase
      .channel('metrics-sync-runs')
      .on('postgres_changes', 
        { event: 'UPDATE', schema: 'public', table: 'sync_runs' },
        (payload) => {
          const status = (payload.new as { status?: string }).status;
          if (status === 'completed' || status === 'completed_with_errors') {
            fetchMetrics();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchMetrics]);

  return { metrics, isLoading, refetch: fetchMetrics };
}
