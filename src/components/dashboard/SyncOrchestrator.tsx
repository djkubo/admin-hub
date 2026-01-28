import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RefreshCw, Play, Pause, CheckCircle, AlertCircle, Clock, Database, Users, Zap, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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
  }>({ processed: 0, merged: 0, rate: '0/s', eta: 0, syncRunId: null });
  const [loading, setLoading] = useState(true);

  // Fetch current counts
  const fetchCounts = useCallback(async () => {
    try {
      // GHL raw counts
      const { count: ghlTotal } = await supabase
        .from('ghl_contacts_raw')
        .select('*', { count: 'exact', head: true });
      
      const { count: ghlUnprocessed } = await supabase
        .from('ghl_contacts_raw')
        .select('*', { count: 'exact', head: true })
        .is('processed_at', null);

      // ManyChat raw counts
      const { count: manychatTotal } = await supabase
        .from('manychat_contacts_raw')
        .select('*', { count: 'exact', head: true });
      
      const { count: manychatUnprocessed } = await supabase
        .from('manychat_contacts_raw')
        .select('*', { count: 'exact', head: true })
        .is('processed_at', null);

      // CSV raw counts
      const { count: csvTotal } = await supabase
        .from('csv_imports_raw')
        .select('*', { count: 'exact', head: true });
      
      const { count: csvStaged } = await supabase
        .from('csv_imports_raw')
        .select('*', { count: 'exact', head: true })
        .eq('processing_status', 'staged');

      setRawCounts({
        ghl_total: ghlTotal || 0,
        ghl_unprocessed: ghlUnprocessed || 0,
        manychat_total: manychatTotal || 0,
        manychat_unprocessed: manychatUnprocessed || 0,
        csv_staged: csvStaged || 0,
        csv_total: csvTotal || 0
      });

      setPendingCounts({
        ghl: ghlUnprocessed || 0,
        manychat: manychatUnprocessed || 0,
        csv: csvStaged || 0,
        total: (ghlUnprocessed || 0) + (manychatUnprocessed || 0) + (csvStaged || 0)
      });

      setLoading(false);
    } catch (error) {
      console.error('Error fetching counts:', error);
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

  // Polling logic for real-time updates
  const pollingIntervals = useRef<Record<string, NodeJS.Timeout>>({});
  
  const startPolling = useCallback((source: string, syncRunId: string) => {
    // Clear existing interval
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

        // Stop polling if completed/failed
        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(syncRun.status)) {
          clearInterval(pollingIntervals.current[source]);
          delete pollingIntervals.current[source];
          
          if (syncRun.status === 'completed' || syncRun.status === 'completed_with_errors') {
            toast.success(`${source.toUpperCase()}: ${processed.toLocaleString()} registros sincronizados`);
          } else if (syncRun.status === 'failed') {
            toast.error(`${source.toUpperCase()}: Error - ${syncRun.error_message || 'Unknown'}`);
          }
          
          // Update to completed status
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

    // Poll immediately, then every 3 seconds
    poll();
    pollingIntervals.current[source] = setInterval(poll, 3000);
  }, []);

  // Cleanup polling on unmount
  const pollingIntervalsRef = useRef(pollingIntervals);
  useEffect(() => {
    return () => {
      Object.values(pollingIntervalsRef.current.current).forEach(clearInterval);
    };
  }, []);

  useEffect(() => {
    fetchCounts();
    // Check for active syncs on mount
    checkActiveSync('stripe');
    checkActiveSync('paypal');
    
    const interval = setInterval(fetchCounts, 5000);
    return () => clearInterval(interval);
  }, [fetchCounts, checkActiveSync]);

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

  // Sync Stripe (Full History with Backend Auto-Chain)
  const syncStripe = async (resume = false) => {
    setSyncStatuses(prev => ({ 
      ...prev, 
      stripe: { ...prev.stripe, status: 'running', processed: resume ? prev.stripe.processed : 0 } 
    }));
    
    try {
      const { data, error } = await supabase.functions.invoke('fetch-stripe', {
        body: resume ? { resumeSync: true } : { fetchAll: true }
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

      // Start polling for real-time progress
      if (syncRunId) {
        startPolling('stripe', syncRunId);
        toast.success(resume 
          ? `Stripe: Reanudando desde ${(data.resumedFrom || 0).toLocaleString()} registros` 
          : 'Stripe: Sync iniciado con auto-continuación'
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

  // Resume paused Stripe sync
  const resumeStripe = () => syncStripe(true);
  
  // Handler for button click (no resume)
  const handleSyncStripe = () => syncStripe(false);

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

  // Unify All Sources (using new bulk-unify-contacts)
  const unifyAll = async () => {
    setIsUnifying(true);
    setUnifyProgress(0);
    setUnifyStats({ processed: 0, merged: 0, rate: '0/s', eta: 0, syncRunId: null });

    try {
      const { data, error } = await supabase.functions.invoke('bulk-unify-contacts', {
        body: { sources: ['ghl', 'manychat', 'csv'], batchSize: 200 }
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Unknown error');

      toast.success('Unificación masiva iniciada');
      
      // Poll for progress
      if (data?.syncRunId) {
        setUnifyStats(prev => ({ ...prev, syncRunId: data.syncRunId }));
        
        const pollProgress = async () => {
          try {
            const { data: syncRun } = await supabase
              .from('sync_runs')
              .select('status, total_fetched, total_inserted, checkpoint, metadata')
              .eq('id', data.syncRunId)
              .single();

            if (syncRun) {
              const checkpoint = (syncRun.checkpoint || {}) as {
                progressPct?: number;
                rate?: string;
                estimatedRemainingSeconds?: number;
              };
              
              const progress = checkpoint.progressPct || 
                (pendingCounts.total > 0 ? Math.min((syncRun.total_fetched || 0) / pendingCounts.total * 100, 100) : 0);
              
              setUnifyProgress(progress);
              setUnifyStats(prev => ({
                ...prev,
                processed: syncRun.total_fetched || 0,
                merged: syncRun.total_inserted || 0,
                rate: checkpoint.rate || '0/s',
                eta: checkpoint.estimatedRemainingSeconds || 0
              }));

              if (syncRun.status === 'completed') {
                setIsUnifying(false);
                setUnifyProgress(100);
                toast.success(`✅ Unificación completada: ${(syncRun.total_inserted || 0).toLocaleString()} registros fusionados`);
                fetchCounts();
              } else if (syncRun.status === 'failed') {
                setIsUnifying(false);
                toast.error('Error en la unificación');
              } else if (syncRun.status === 'cancelled') {
                setIsUnifying(false);
                toast.info('Unificación cancelada');
              } else {
                setTimeout(pollProgress, 2000);
              }
            }
          } catch (pollError) {
            console.error('Poll error:', pollError);
            setTimeout(pollProgress, 3000);
          }
        };
        
        pollProgress();
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
      await supabase.functions.invoke('unify-all-sources', { body: { forceCancel: true } });
      
      setSyncStatuses({
        stripe: { source: 'stripe', status: 'idle', processed: 0 },
        paypal: { source: 'paypal', status: 'idle', processed: 0 },
        ghl: { source: 'ghl', status: 'idle', processed: 0 },
        manychat: { source: 'manychat', status: 'idle', processed: 0 },
      });
      setIsUnifying(false);
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
                
                {/* Show Resume button if paused */}
                {syncStatuses.stripe.status === 'paused' || syncStatuses.stripe.canResume ? (
                  <Button 
                    className="w-full mt-3 bg-orange-500 hover:bg-orange-600" 
                    size="sm"
                    onClick={resumeStripe}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Reanudar ({syncStatuses.stripe.processed.toLocaleString()})
                  </Button>
                ) : (
                  <Button 
                    className="w-full mt-3" 
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

          {isUnifying && (
            <div className="mb-4 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Progreso de unificación masiva</span>
                <span className="text-sm text-muted-foreground">{Math.round(unifyProgress)}%</span>
              </div>
              <Progress value={unifyProgress} className="h-3 mb-3" />
              <div className="grid grid-cols-4 gap-4 text-center text-sm">
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
                  <div className="font-bold text-lg">{unifyStats.eta > 0 ? `${Math.ceil(unifyStats.eta / 60)}m` : '-'}</div>
                  <div className="text-muted-foreground">Tiempo restante</div>
                </div>
              </div>
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

          {pendingCounts.total === 0 && !isUnifying && (
            <p className="text-sm text-muted-foreground text-center mt-4">
              ✓ No hay registros pendientes de unificar
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
