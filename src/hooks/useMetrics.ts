import { useState, useEffect, useCallback } from 'react';
import { getMetrics } from '@/lib/csvProcessor';

interface Metrics {
  salesToday: number;
  conversionRate: number;
  recoveryList: Array<{
    email: string;
    full_name: string | null;
    phone: string | null;
    payment_status: string | null;
  }>;
  trialCount: number;
  convertedCount: number;
}

export function useMetrics() {
  const [metrics, setMetrics] = useState<Metrics>({
    salesToday: 0,
    conversionRate: 0,
    recoveryList: [],
    trialCount: 0,
    convertedCount: 0
  });
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
