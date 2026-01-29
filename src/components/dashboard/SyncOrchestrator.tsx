import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, Play, Pause, CheckCircle, AlertCircle, Clock, Database, Users, Zap, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Time range options for Stripe sync
type TimeRange = '24h' | '7d' | '31d' | '6m' | 'all';

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string; description: string }[] = [
  { value: '24h', label: 'Últimas 24 horas', description: '~100-500 transacciones' },
  { value: '7d', label: 'Últimos 7 días', description: '~500-2,000 transacciones' },
  { value: '31d', label: 'Últimos 31 días', description: '~2,000-5,000 transacciones' },
  { value: '6m', label: 'Últimos 6 meses', description: '~10,000-30,000 transacciones' },
  { value: 'all', label: 'Todo el historial', description: 'Puede tomar varios minutos' },
];

function getDateRangeForTimeRange(timeRange: TimeRange): { startDate: string | null; endDate: string | null } {
  const now = new Date();
  const endDate = now.toISOString();
  
  switch (timeRange) {
    case '24h': {
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return { startDate: start.toISOString(), endDate };
    }
    case '7d': {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { startDate: start.toISOString(), endDate };
    }
    case '31d': {
      const start = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      return { startDate: start.toISOString(), endDate };
    }
    case '6m': {
      const start = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);
      return { startDate: start.toISOString(), endDate };
    }
    case 'all':
    default:
      return { startDate: null, endDate: null };
  }
}

interface SyncStatus {
  source: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'continuing' | 'paused';
  processed: number;
  total?: number;
  error?: string;
  syncRunId?: string;
  chunk?: number;
  lastActivity?: string;
  canResume?: boolean;
}

interface PendingCounts {
  ghl: number;
  manychat: number;
  csv: number;
  total: number;
}

interface RawCounts {
  ghl_total: number;
  ghl_unprocessed: number;
  manychat_total: number;
  manychat_unprocessed: number;
  csv_staged: number;
  csv_total: number;
}

export function SyncOrchestrator() {
  const [stripeTimeRange, setStripeTimeRange] = useState<TimeRange>('all');
  const [syncStatuses, setSyncStatuses] = useState<Record<string, SyncStatus>>({
    stripe: { source: 'stripe', status: 'idle', processed: 0 },
    paypal: { source: 'paypal', status: 'idle', processed: 0 },
    ghl: { source: 'ghl', status: 'idle', processed: 0 },
    manychat: { source: 'manychat', status: 'idle', processed: 0 },
  });
  const [rawCounts, setRawCounts] = useState<RawCounts>({
    ghl_total: 0, ghl_unprocessed: 0,
    manychat_total: 0, manychat_unprocessed: 0,
    csv_staged: 0, csv_total: 0
  });
  const [pendingCounts, setPendingCounts] = useState<PendingCounts>({ ghl: 0, manychat: 0, csv: 0, total: 0 });
  const [isUnifying, setIsUnifying] = useState(false);
  const [unifyProgress, setUnifyProgress] = useState(0);
  const [unifyStats, setUnifyStats] = useState<{
    processed: number;
    merged: number;
    rate: string;
    eta: number;
    syncRunId: string | null;
    chunk: number;
    canResume: boolean;
  }>({ processed: 0, merged: 0, rate: '0/s', eta: 0, syncRunId: null, chunk: 0, canResume: false });
  const [loading, setLoading] = useState(true);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch current counts using accurate RPC (with partial indexes for speed)
  const fetchCounts = useCallback(async () => {
    try {
      // Try new accurate RPC first
      const { data, error } = await supabase.rpc('get_staging_counts_accurate');

      if (error) {
        console.error('RPC error, trying fast fallback:', error);
        // Fallback to fast RPC
        const { data: fastData } = await supabase.rpc('get_staging_counts_fast');
        if (fastData) {
          const counts = fastData as Record<string, number>;
          setRawCounts({
            ghl_total: counts.ghl_total || 0,
            ghl_unprocessed: counts.ghl_unprocessed || 0,
            manychat_total: counts.manychat_total || 0,
            manychat_unprocessed: counts.manychat_unprocessed || 0,
            csv_staged: counts.csv_staged || 0,
            csv_total: counts.csv_total || 0
          });
          setPendingCounts({
            ghl: counts.ghl_unprocessed || 0,
            manychat: counts.manychat_unprocessed || 0,
            csv: counts.csv_staged || 0,
            total: (counts.ghl_unprocessed || 0) + (counts.manychat_unprocessed || 0) + (counts.csv_staged || 0)
          });
        }
        setLoading(false);
        return;
      }

      const counts = data as {
        ghl_total: number;
        ghl_unprocessed: number;
        manychat_total: number;
        manychat_unprocessed: number;
        csv_total: number;
        csv_staged: number;
        clients_total: number;
        transactions_total: number;
      };

      setRawCounts({
        ghl_total: counts.ghl_total || 0,
        ghl_unprocessed: counts.ghl_unprocessed || 0,
        manychat_total: counts.manychat_total || 0,
        manychat_unprocessed: counts.manychat_unprocessed || 0,
        csv_staged: counts.csv_staged || 0,
        csv_total: counts.csv_total || 0
      });

      setPendingCounts({
        ghl: counts.ghl_unprocessed || 0,
        manychat: counts.manychat_unprocessed || 0,
        csv: counts.csv_staged || 0,
        total: (counts.ghl_unprocessed || 0) + (counts.manychat_unprocessed || 0) + (counts.csv_staged || 0)
      });

      setLoading(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error fetching counts:', errorMessage);
      setLoading(false);
    }
  }, []);

  // Check for active syncs on mount and start polling
  const checkActiveSync = useCallback(async (source: string) => {
    try {
      const { data: activeRun } = await supabase
        .from('sync_runs')
        .select('id, status, total_fetched, checkpoint, error_message')
        .eq('source', source)
        .in('status', ['running', 'continuing', 'paused'])
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeRun) {
        const checkpoint = activeRun.checkpoint as { 
          chunk?: number; 
          runningTotal?: number; 
          lastActivity?: string;
          canResume?: boolean;
        } | null;
        
        setSyncStatuses(prev => ({
          ...prev,
          [source]: {
            ...prev[source],
            status: activeRun.status as SyncStatus['status'],
            processed: checkpoint?.runningTotal || activeRun.total_fetched || 0,
            syncRunId: activeRun.id,
            chunk: checkpoint?.chunk,
            lastActivity: checkpoint?.lastActivity,
            canResume: activeRun.status === 'paused' || checkpoint?.canResume,
            error: activeRun.error_message || undefined
          }
        }));

        // Start polling if running
        if (activeRun.status === 'running' || activeRun.status === 'continuing') {
          startPolling(source, activeRun.id);
        }
      }
    } catch (error) {
      console.error(`Error checking active ${source} sync:`, error);
    }
  }, []);

  // Check for active unification on mount
  const checkActiveUnification = useCallback(async () => {
    try {
      const { data: activeRun } = await supabase
        .from('sync_runs')
        .select('id, status, total_fetched, total_inserted, checkpoint, metadata, error_message')
        .eq('source', 'bulk_unify')
        .in('status', ['running', 'continuing', 'paused'])
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeRun) {
        const checkpoint = activeRun.checkpoint as { 
          chunk?: number; 
          progressPct?: number;
          rate?: string;
          estimatedRemainingSeconds?: number;
          canResume?: boolean;
        } | null;
        
        const metadata = activeRun.metadata as { pending?: { total?: number } } | null;
        const totalPending = metadata?.pending?.total || pendingCounts.total;
        
        setIsUnifying(activeRun.status !== 'paused');
        setUnifyProgress(checkpoint?.progressPct || 0);
        setUnifyStats({
          processed: activeRun.total_fetched || 0,
          merged: activeRun.total_inserted || 0,
          rate: checkpoint?.rate || '0/s',
          eta: checkpoint?.estimatedRemainingSeconds || 0,
          syncRunId: activeRun.id,
          chunk: checkpoint?.chunk || 0,
          canResume: activeRun.status === 'paused' || checkpoint?.canResume || false
        });

        if (activeRun.status === 'running' || activeRun.status === 'continuing') {
          startUnifyPolling(activeRun.id, totalPending);
        }
      }
    } catch (error) {
      console.error('Error checking active unification:', error);
    }
  }, [pendingCounts.total]);

  // Polling logic for real-time updates
  const pollingIntervals = useRef<Record<string, NodeJS.Timeout>>({});
  
  const startPolling = useCallback((source: string, syncRunId: string) => {
    if (pollingIntervals.current[source]) {
      clearInterval(pollingIntervals.current[source]);
    }

    const poll = async () => {
      try {
        const { data: syncRun } = await supabase
          .from('sync_runs')
          .select('id, status, total_fetched, checkpoint, error_message, completed_at')
          .eq('id', syncRunId)
          .single();

        if (!syncRun) return;

        const checkpoint = syncRun.checkpoint as { 
          chunk?: number; 
          runningTotal?: number; 
          lastActivity?: string;
          canResume?: boolean;
        } | null;

        const processed = checkpoint?.runningTotal || syncRun.total_fetched || 0;
        
        setSyncStatuses(prev => ({
          ...prev,
          [source]: {
            ...prev[source],
            status: syncRun.status as SyncStatus['status'],
            processed,
            chunk: checkpoint?.chunk,
            lastActivity: checkpoint?.lastActivity,
            canResume: syncRun.status === 'paused' || checkpoint?.canResume,
            error: syncRun.error_message || undefined
          }
        }));

        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(syncRun.status)) {
          clearInterval(pollingIntervals.current[source]);
          delete pollingIntervals.current[source];
          
          if (syncRun.status === 'completed' || syncRun.status === 'completed_with_errors') {
            toast.success(`${source.toUpperCase()}: ${processed.toLocaleString()} registros sincronizados`);
          } else if (syncRun.status === 'failed') {
            toast.error(`${source.toUpperCase()}: Error - ${syncRun.error_message || 'Unknown'}`);
          }
          
          setSyncStatuses(prev => ({
            ...prev,
            [source]: {
              ...prev[source],
              status: syncRun.status === 'completed' || syncRun.status === 'completed_with_errors' 
                ? 'completed' 
                : syncRun.status === 'paused' ? 'paused' : 'error'
            }
          }));
        }
      } catch (error) {
        console.error(`Poll error for ${source}:`, error);
      }
    };

    poll();
    pollingIntervals.current[source] = setInterval(poll, 3000);
  }, []);

  // Adaptive polling for unification (5s when active, 15s when stalled)
  const startUnifyPolling = useCallback((syncRunId: string, totalPending: number) => {
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
    }

    let lastProcessed = 0;
    let stalledCount = 0;

    const poll = async () => {
      try {
        const { data: syncRun } = await supabase
          .from('sync_runs')
          .select('status, total_fetched, total_inserted, checkpoint, metadata')
          .eq('id', syncRunId)
          .single();

        if (!syncRun) return;

        const checkpoint = (syncRun.checkpoint || {}) as {
          chunk?: number;
          progressPct?: number;
          rate?: string;
          estimatedRemainingSeconds?: number;
          canResume?: boolean;
          lastActivity?: string;
        };

        const currentProcessed = syncRun.total_fetched || 0;
        
        // Detect stalled progress
        if (currentProcessed === lastProcessed) {
          stalledCount++;
        } else {
          stalledCount = 0;
          lastProcessed = currentProcessed;
        }
        
        const progress = checkpoint.progressPct || 
          (totalPending > 0 ? Math.min((currentProcessed / totalPending) * 100, 100) : 0);
        
        setUnifyProgress(progress);
        setUnifyStats(prev => ({
          ...prev,
          processed: currentProcessed,
          merged: syncRun.total_inserted || 0,
          rate: checkpoint.rate || '0/s',
          eta: checkpoint.estimatedRemainingSeconds || 0,
          chunk: checkpoint.chunk || 0,
          canResume: syncRun.status === 'paused' || checkpoint.canResume || false
        }));

        if (syncRun.status === 'completed') {
          setIsUnifying(false);
          setUnifyProgress(100);
          toast.success(`✅ Unificación completada: ${(syncRun.total_inserted || 0).toLocaleString()} registros fusionados`);
          fetchCounts();
          return;
        } else if (syncRun.status === 'failed') {
          setIsUnifying(false);
          toast.error('Error en la unificación');
          return;
        } else if (syncRun.status === 'cancelled') {
          setIsUnifying(false);
          toast.info('Unificación cancelada');
          return;
        } else if (syncRun.status === 'paused') {
          setIsUnifying(false);
          setUnifyStats(prev => ({ ...prev, canResume: true }));
          toast.warning('Unificación pausada - puede reanudarse');
          return;
        }

        // Adaptive polling interval: 5s normal, 15s when stalled
        const pollInterval = stalledCount >= 3 ? 15000 : 5000;
        pollingTimeoutRef.current = setTimeout(poll, pollInterval);
      } catch (pollError) {
        console.error('Poll error:', pollError);
        pollingTimeoutRef.current = setTimeout(poll, 5000);
      }
    };
    
    poll();
  }, [fetchCounts]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      Object.values(pollingIntervals.current).forEach(clearInterval);
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fetchCounts();
    checkActiveSync('stripe');
    checkActiveSync('paypal');
    checkActiveUnification();
  }, [fetchCounts, checkActiveSync, checkActiveUnification]);

  // Sync GHL (Stage Only)
  const syncGHL = async () => {
    setSyncStatuses(prev => ({ ...prev, ghl: { ...prev.ghl, status: 'running', processed: 0 } }));
    
    let hasMore = true;
    let startAfterId: string | null = null;
    let startAfter: number | null = null;
    let syncRunId: string | null = null;
    let totalProcessed = 0;

    try {
      while (hasMore) {
        const { data, error } = await supabase.functions.invoke('sync-ghl', {
          body: { 
            stageOnly: true, 
            startAfterId, 
            startAfter,
            syncRunId 
          }
        });

        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error || 'Unknown error');

        totalProcessed += data.processed || 0;
        syncRunId = data.syncRunId;
        hasMore = data.hasMore === true;
        startAfterId = data.nextStartAfterId;
        startAfter = data.nextStartAfter;

        setSyncStatuses(prev => ({ 
          ...prev, 
          ghl: { ...prev.ghl, processed: totalProcessed, syncRunId } 
        }));

        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      setSyncStatuses(prev => ({ 
        ...prev, 
        ghl: { ...prev.ghl, status: 'completed', processed: totalProcessed } 
      }));
      toast.success(`GHL: ${totalProcessed} contactos descargados`);
      fetchCounts();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSyncStatuses(prev => ({ 
        ...prev, 
        ghl: { ...prev.ghl, status: 'error', error: errorMessage } 
      }));
      toast.error(`Error GHL: ${errorMessage}`);
    }
  };

  // Sync ManyChat (Stage Only)
  const syncManyChat = async () => {
    setSyncStatuses(prev => ({ ...prev, manychat: { ...prev.manychat, status: 'running', processed: 0 } }));
    
    let hasMore = true;
    let cursor = 0;
    let syncRunId: string | null = null;
    let totalProcessed = 0;

    try {
      while (hasMore) {
        const { data, error } = await supabase.functions.invoke('sync-manychat', {
          body: { 
            stageOnly: true, 
            cursor,
            syncRunId 
          }
        });

        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error || 'Unknown error');

        totalProcessed += data.staged || data.processed || 0;
        syncRunId = data.syncRunId;
        hasMore = data.hasMore === true;
        cursor = parseInt(data.nextCursor || '0', 10);

        setSyncStatuses(prev => ({ 
          ...prev, 
          manychat: { ...prev.manychat, processed: totalProcessed, syncRunId } 
        }));

        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      setSyncStatuses(prev => ({ 
        ...prev, 
        manychat: { ...prev.manychat, status: 'completed', processed: totalProcessed } 
      }));
      toast.success(`ManyChat: ${totalProcessed} contactos descargados`);
      fetchCounts();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSyncStatuses(prev => ({ 
        ...prev, 
        manychat: { ...prev.manychat, status: 'error', error: errorMessage } 
      }));
      toast.error(`Error ManyChat: ${errorMessage}`);
    }
  };

  // Sync Stripe with time range (Full History with Backend Auto-Chain)
  const syncStripe = async (resume = false, timeRange: TimeRange = 'all') => {
    setSyncStatuses(prev => ({ 
      ...prev, 
      stripe: { ...prev.stripe, status: 'running', processed: resume ? prev.stripe.processed : 0 } 
    }));
    
    try {
      let requestBody: Record<string, unknown>;
      
      if (resume) {
        requestBody = { resumeSync: true };
      } else {
        const { startDate, endDate } = getDateRangeForTimeRange(timeRange);
        requestBody = { 
          fetchAll: true,
          ...(startDate && { startDate }),
          ...(endDate && { endDate })
        };
      }

      const { data, error } = await supabase.functions.invoke('fetch-stripe', {
        body: requestBody
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || data?.message || 'Unknown error');

      const syncRunId = data.syncRunId;
      
      setSyncStatuses(prev => ({ 
        ...prev, 
        stripe: { 
          ...prev.stripe, 
          syncRunId,
          processed: resume ? (data.resumedFrom || prev.stripe.processed) : 0
        } 
      }));

      if (syncRunId) {
        startPolling('stripe', syncRunId);
        const rangeLabel = TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.label || 'Todo';
        toast.success(resume 
          ? `Stripe: Reanudando desde ${(data.resumedFrom || 0).toLocaleString()} registros` 
          : `Stripe: Sync iniciado (${rangeLabel})`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSyncStatuses(prev => ({ 
        ...prev, 
        stripe: { ...prev.stripe, status: 'error', error: errorMessage } 
      }));
      toast.error(`Error Stripe: ${errorMessage}`);
    }
  };

  const resumeStripe = () => syncStripe(true, stripeTimeRange);
  const handleSyncStripe = () => syncStripe(false, stripeTimeRange);

  // Sync PayPal
  const syncPayPal = async () => {
    setSyncStatuses(prev => ({ ...prev, paypal: { ...prev.paypal, status: 'running', processed: 0 } }));
    
    try {
      const { data, error } = await supabase.functions.invoke('fetch-paypal', {
        body: { mode: 'full' }
      });

      if (error) throw error;

      setSyncStatuses(prev => ({ 
        ...prev, 
        paypal: { ...prev.paypal, status: 'completed', processed: data?.synced || 0 } 
      }));
      toast.success(`PayPal: ${data?.synced || 0} transacciones sincronizadas`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSyncStatuses(prev => ({ 
        ...prev, 
        paypal: { ...prev.paypal, status: 'error', error: errorMessage } 
      }));
      toast.error(`Error PayPal: ${errorMessage}`);
    }
  };

  // Unify All Sources (using bulk-unify-contacts v3)
  const unifyAll = async () => {
    setIsUnifying(true);
    setUnifyProgress(0);
    setUnifyStats({ processed: 0, merged: 0, rate: '0/s', eta: 0, syncRunId: null, chunk: 0, canResume: false });

    try {
      const { data, error } = await supabase.functions.invoke('bulk-unify-contacts', {
        body: { sources: ['ghl', 'manychat', 'csv'], batchSize: 2000 }
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Unknown error');

      toast.success(`Unificación masiva iniciada (ETA: ${data.estimatedTime || '~30 min'})`);
      
      if (data?.syncRunId) {
        setUnifyStats(prev => ({ ...prev, syncRunId: data.syncRunId }));
        startUnifyPolling(data.syncRunId, data.pending?.total || pendingCounts.total);
      }
    } catch (error) {
      setIsUnifying(false);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Resume paused unification
  const resumeUnification = async () => {
    setIsUnifying(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('bulk-unify-contacts', {
        body: { sources: ['ghl', 'manychat', 'csv'], batchSize: 2000 }
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Unknown error');

      toast.success(data.message || 'Reanudando unificación...');
      
      if (data?.syncRunId) {
        setUnifyStats(prev => ({ ...prev, syncRunId: data.syncRunId, canResume: false }));
        startUnifyPolling(data.syncRunId, pendingCounts.total);
      }
    } catch (error) {
      setIsUnifying(false);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Cancel unification
  const cancelUnification = async () => {
    try {
      await supabase.functions.invoke('bulk-unify-contacts', { body: { forceCancel: true } });
      setIsUnifying(false);
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
      toast.success('Unificación cancelada');
    } catch (error) {
      toast.error('Error cancelando unificación');
    }
  };

  // Cancel all syncs
  const cancelAll = async () => {
    try {
      await supabase.functions.invoke('sync-command-center', { body: { forceCancel: true } });
      await supabase.functions.invoke('sync-ghl', { body: { forceCancel: true } });
      await supabase.functions.invoke('sync-manychat', { body: { forceCancel: true } });
      await supabase.functions.invoke('bulk-unify-contacts', { body: { forceCancel: true } });
      
      setSyncStatuses({
        stripe: { source: 'stripe', status: 'idle', processed: 0 },
        paypal: { source: 'paypal', status: 'idle', processed: 0 },
        ghl: { source: 'ghl', status: 'idle', processed: 0 },
        manychat: { source: 'manychat', status: 'idle', processed: 0 },
      });
      setIsUnifying(false);
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
      toast.success('Todas las sincronizaciones canceladas');
    } catch (error) {
      toast.error('Error cancelando sincronizaciones');
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
      case 'continuing':
        return <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      case 'paused':
        return <Pause className="h-4 w-4 text-orange-500" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running':
      case 'continuing':
        return <Badge variant="default" className="bg-blue-500">En progreso</Badge>;
      case 'completed':
        return <Badge variant="default" className="bg-green-500">Completado</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      case 'paused':
        return <Badge variant="default" className="bg-orange-500">Pausado</Badge>;
      default:
        return <Badge variant="secondary">Inactivo</Badge>;
    }
  };

  // Format ETA nicely
  const formatETA = (seconds: number) => {
    if (seconds <= 0) return '-';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-8">
          <RefreshCw className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Centro de Sincronización</h2>
          <p className="text-muted-foreground">Descarga data de todas las APIs y unifica identidades</p>
        </div>
        <Button variant="destructive" size="sm" onClick={cancelAll}>
          <XCircle className="h-4 w-4 mr-2" />
          Cancelar Todo
        </Button>
      </div>

      {/* Phase 1: Download Data */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Fase 1: Descargar Data
          </CardTitle>
          <CardDescription>
            Descarga contactos y transacciones de las APIs (sin fusionar)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Stripe */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">Stripe</span>
                  {getStatusIcon(syncStatuses.stripe.status)}
                </div>
                <div className="text-2xl font-bold">{syncStatuses.stripe.processed.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground mb-1">registros</div>
                {syncStatuses.stripe.chunk && (
                  <div className="text-xs text-blue-500 mb-1">Chunk {syncStatuses.stripe.chunk}</div>
                )}
                {syncStatuses.stripe.lastActivity && (
                  <div className="text-xs text-muted-foreground mb-2">
                    Última act: {new Date(syncStatuses.stripe.lastActivity).toLocaleTimeString()}
                  </div>
                )}
                {getStatusBadge(syncStatuses.stripe.status)}
                
                {(syncStatuses.stripe.status === 'idle' || syncStatuses.stripe.status === 'completed' || syncStatuses.stripe.status === 'error') && (
                  <div className="mt-3 mb-2">
                    <Select value={stripeTimeRange} onValueChange={(value: TimeRange) => setStripeTimeRange(value)}>
                      <SelectTrigger className="w-full h-8 text-xs">
                        <SelectValue placeholder="Seleccionar rango" />
                      </SelectTrigger>
                      <SelectContent>
                        {TIME_RANGE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            <div className="flex flex-col">
                              <span>{option.label}</span>
                              <span className="text-xs text-muted-foreground">{option.description}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                
                {syncStatuses.stripe.status === 'paused' || syncStatuses.stripe.canResume ? (
                  <Button 
                    className="w-full mt-2 bg-orange-500 hover:bg-orange-600" 
                    size="sm"
                    onClick={resumeStripe}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Reanudar ({syncStatuses.stripe.processed.toLocaleString()})
                  </Button>
                ) : (
                  <Button 
                    className="w-full mt-2" 
                    size="sm"
                    onClick={handleSyncStripe}
                    disabled={syncStatuses.stripe.status === 'running' || syncStatuses.stripe.status === 'continuing'}
                  >
                    {syncStatuses.stripe.status === 'running' || syncStatuses.stripe.status === 'continuing' ? (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                        Sincronizando...
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4 mr-2" />
                        Sync Stripe
                      </>
                    )}
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* PayPal */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">PayPal</span>
                  {getStatusIcon(syncStatuses.paypal.status)}
                </div>
                <div className="text-2xl font-bold">{syncStatuses.paypal.processed.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground mb-3">transacciones</div>
                {getStatusBadge(syncStatuses.paypal.status)}
                <Button 
                  className="w-full mt-3" 
                  size="sm"
                  onClick={syncPayPal}
                  disabled={syncStatuses.paypal.status === 'running'}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Sync PayPal
                </Button>
              </CardContent>
            </Card>

            {/* GHL */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">GoHighLevel</span>
                  {getStatusIcon(syncStatuses.ghl.status)}
                </div>
                <div className="text-2xl font-bold">{rawCounts.ghl_total.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground mb-3">
                  en raw ({rawCounts.ghl_unprocessed.toLocaleString()} sin procesar)
                </div>
                {getStatusBadge(syncStatuses.ghl.status)}
                <Button 
                  className="w-full mt-3" 
                  size="sm"
                  onClick={syncGHL}
                  disabled={syncStatuses.ghl.status === 'running'}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Sync GHL
                </Button>
              </CardContent>
            </Card>

            {/* ManyChat */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">ManyChat</span>
                  {getStatusIcon(syncStatuses.manychat.status)}
                </div>
                <div className="text-2xl font-bold">{rawCounts.manychat_total.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground mb-3">
                  en raw ({rawCounts.manychat_unprocessed.toLocaleString()} sin procesar)
                </div>
                {getStatusBadge(syncStatuses.manychat.status)}
                <Button 
                  className="w-full mt-3" 
                  size="sm"
                  onClick={syncManyChat}
                  disabled={syncStatuses.manychat.status === 'running'}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Sync ManyChat
                </Button>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Phase 2: Unify */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Fase 2: Unificar Identidades
          </CardTitle>
          <CardDescription>
            Fusiona todos los contactos descargados en la tabla principal de clientes
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Card className="bg-muted/50">
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-bold text-primary">{pendingCounts.ghl.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground">GHL pendientes</div>
              </CardContent>
            </Card>
            <Card className="bg-muted/50">
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-bold text-primary">{pendingCounts.manychat.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground">ManyChat pendientes</div>
              </CardContent>
            </Card>
            <Card className="bg-muted/50">
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-bold text-primary">{pendingCounts.csv.toLocaleString()}</div>
                <div className="text-sm text-muted-foreground">CSV pendientes</div>
              </CardContent>
            </Card>
          </div>

          {/* Enhanced Progress Panel */}
          {(isUnifying || unifyStats.canResume) && (
            <div className="mb-4 p-4 bg-muted/50 rounded-lg border border-border">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {isUnifying ? 'Unificación en progreso' : 'Unificación pausada'}
                  </span>
                  {unifyStats.chunk > 0 && (
                    <Badge variant="outline" className="text-xs">
                      Chunk {unifyStats.chunk}
                    </Badge>
                  )}
                </div>
                <span className="text-sm font-bold text-primary">{Math.round(unifyProgress)}%</span>
              </div>
              <Progress value={unifyProgress} className="h-3 mb-4" />
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center text-sm">
                <div>
                  <div className="font-bold text-lg">{unifyStats.processed.toLocaleString()}</div>
                  <div className="text-muted-foreground">Procesados</div>
                </div>
                <div>
                  <div className="font-bold text-lg text-green-600">{unifyStats.merged.toLocaleString()}</div>
                  <div className="text-muted-foreground">Fusionados</div>
                </div>
                <div>
                  <div className="font-bold text-lg text-blue-600">{unifyStats.rate}</div>
                  <div className="text-muted-foreground">Velocidad</div>
                </div>
                <div>
                  <div className="font-bold text-lg">{formatETA(unifyStats.eta)}</div>
                  <div className="text-muted-foreground">Tiempo restante</div>
                </div>
              </div>

              {unifyStats.canResume && !isUnifying && (
                <div className="mt-4 p-3 bg-orange-500/10 rounded-lg border border-orange-500/30">
                  <p className="text-sm text-orange-600 mb-2">
                    El proceso se pausó y puede reanudarse desde donde quedó.
                  </p>
                  <Button 
                    className="w-full bg-orange-500 hover:bg-orange-600"
                    onClick={resumeUnification}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Reanudar desde {unifyStats.processed.toLocaleString()} registros
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-4">
            <Button 
              size="lg" 
              onClick={unifyAll}
              disabled={isUnifying || pendingCounts.total === 0}
              className="flex-1"
            >
              {isUnifying ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Unificando... ({unifyStats.processed.toLocaleString()} de {pendingCounts.total.toLocaleString()})
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Unificar Todo ({pendingCounts.total.toLocaleString()} registros)
                </>
              )}
            </Button>
            {isUnifying ? (
              <Button variant="destructive" onClick={cancelUnification}>
                <Pause className="h-4 w-4 mr-2" />
                Cancelar
              </Button>
            ) : (
              <Button variant="outline" onClick={fetchCounts}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </div>

          {pendingCounts.total === 0 && !isUnifying && !unifyStats.canResume && (
            <p className="text-sm text-muted-foreground text-center mt-4">
              ✓ No hay registros pendientes de unificar
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
