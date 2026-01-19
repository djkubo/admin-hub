import { useState, useEffect, useCallback } from 'react';
import { getMetrics, DashboardMetrics } from '@/lib/csvProcessor';

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
      const data = await getMetrics();
      setMetrics(data);
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
