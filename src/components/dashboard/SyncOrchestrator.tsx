import { useState, useEffect, useCallback } from "react";
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
  status: 'idle' | 'running' | 'completed' | 'error' | 'continuing';
  processed: number;
  total?: number;
  error?: string;
  syncRunId?: string;
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

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 5000);
    return () => clearInterval(interval);
  }, [fetchCounts]);

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

  // Sync Stripe
  const syncStripe = async () => {
    setSyncStatuses(prev => ({ ...prev, stripe: { ...prev.stripe, status: 'running', processed: 0 } }));
    
    try {
      const { data, error } = await supabase.functions.invoke('sync-command-center', {
        body: { mode: 'full' }
      });

      if (error) throw error;

      const totalCount = Object.values(data?.results || {}).reduce((sum: number, r: { count?: number }) => sum + (r?.count || 0), 0);
      
      setSyncStatuses(prev => ({ 
        ...prev, 
        stripe: { ...prev.stripe, status: 'completed', processed: totalCount as number } 
      }));
      toast.success(`Stripe: ${totalCount} registros sincronizados`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSyncStatuses(prev => ({ 
        ...prev, 
        stripe: { ...prev.stripe, status: 'error', error: errorMessage } 
      }));
      toast.error(`Error Stripe: ${errorMessage}`);
    }
  };

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

  // Unify All Sources
  const unifyAll = async () => {
    setIsUnifying(true);
    setUnifyProgress(0);

    try {
      const { data, error } = await supabase.functions.invoke('unify-all-sources', {
        body: { sources: ['ghl', 'manychat', 'csv'] }
      });

      if (error) throw error;

      toast.success('Unificación iniciada en background');
      
      // Poll for progress
      if (data?.syncRunId) {
        const pollProgress = async () => {
          const { data: syncRun } = await supabase
            .from('sync_runs')
            .select('status, total_fetched, total_inserted')
            .eq('id', data.syncRunId)
            .single();

          if (syncRun) {
            const progress = syncRun.total_fetched ? Math.min((syncRun.total_fetched / pendingCounts.total) * 100, 100) : 0;
            setUnifyProgress(progress);

            if (syncRun.status === 'completed') {
              setIsUnifying(false);
              toast.success(`Unificación completada: ${syncRun.total_inserted} registros fusionados`);
              fetchCounts();
            } else if (syncRun.status === 'failed') {
              setIsUnifying(false);
              toast.error('Error en la unificación');
            } else {
              setTimeout(pollProgress, 2000);
            }
          }
        };
        
        pollProgress();
      }
    } catch (error) {
      setIsUnifying(false);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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
                <div className="text-sm text-muted-foreground mb-3">registros</div>
                {getStatusBadge(syncStatuses.stripe.status)}
                <Button 
                  className="w-full mt-3" 
                  size="sm"
                  onClick={syncStripe}
                  disabled={syncStatuses.stripe.status === 'running'}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Sync Stripe
                </Button>
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
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Progreso de unificación</span>
                <span className="text-sm text-muted-foreground">{Math.round(unifyProgress)}%</span>
              </div>
              <Progress value={unifyProgress} className="h-2" />
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
                  Unificando...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Unificar Todo ({pendingCounts.total.toLocaleString()} registros)
                </>
              )}
            </Button>
            <Button variant="outline" onClick={fetchCounts}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {pendingCounts.total === 0 && (
            <p className="text-sm text-muted-foreground text-center mt-4">
              ✓ No hay registros pendientes de unificar
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
