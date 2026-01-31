import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { 
  CheckCircle, 
  XCircle, 
  Clock, 
  Loader2, 
  ChevronDown, 
  ChevronUp,
  RefreshCw,
  CreditCard,
  FileText,
  Users,
  StopCircle,
  Skull,
  AlertTriangle,
  PlayCircle
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { invokeWithAdminKey } from "@/lib/adminApi";
import type { Json } from "@/integrations/supabase/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface SyncRun {
  id: string;
  source: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_fetched: number | null;
  total_inserted: number | null;
  total_updated: number | null;
  error_message: string | null;
  checkpoint: Json | null;
  dry_run: boolean | null;
}

const SOURCE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  stripe: { label: "Stripe", icon: CreditCard, color: "text-white" },
  paypal: { label: "PayPal", icon: CreditCard, color: "text-white" },
  subscriptions: { label: "Suscripciones", icon: RefreshCw, color: "text-white" },
  invoices: { label: "Facturas", icon: FileText, color: "text-white" },
  ghl: { label: "GoHighLevel", icon: Users, color: "text-white" },
  manychat: { label: "ManyChat", icon: Users, color: "text-white" },
  "command-center": { label: "Command Center", icon: RefreshCw, color: "text-white" },
  bulk_unify: { label: "Unificación Masiva", icon: Users, color: "text-white" },
};

export function SyncResultsPanel() {
  const [recentRuns, setRecentRuns] = useState<SyncRun[]>([]);
  const [failedResumable, setFailedResumable] = useState<SyncRun[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeSyncs, setActiveSyncs] = useState<SyncRun[]>([]);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isForceKilling, setIsForceKilling] = useState(false);
  const [isResuming, setIsResuming] = useState<string | null>(null);

  const fetchRuns = async () => {
    // Active/running syncs
    const { data: active } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["running", "continuing"])
      .order("started_at", { ascending: false });
    
    setActiveSyncs((active || []) as SyncRun[]);

    // Recent completed/failed syncs (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["completed", "completed_with_errors"])
      .gte("completed_at", oneHourAgo)
      .order("completed_at", { ascending: false })
      .limit(10);

    setRecentRuns((recent || []) as SyncRun[]);
    
    // Failed syncs with checkpoint (resumable) - last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: failed } = await supabase
      .from("sync_runs")
      .select("*")
      .eq("status", "failed")
      .not("checkpoint", "is", null)
      .gte("completed_at", oneDayAgo)
      .order("completed_at", { ascending: false })
      .limit(5);
    
    // Filter to only those with real checkpoint data
    const resumableFailed = (failed || []).filter((run: SyncRun) => {
      const cp = run.checkpoint as Record<string, unknown> | null;
      return cp && (cp.cursor || cp.runningTotal);
    });
    
    setFailedResumable(resumableFailed as SyncRun[]);
  };

  useEffect(() => {
    fetchRuns();
    // OPTIMIZATION: Reduced polling from 5s to 30s - Realtime handles instant updates
    const interval = setInterval(fetchRuns, 30000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to realtime changes
  useEffect(() => {
    const channel = supabase
      .channel('sync_runs_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sync_runs' },
        () => {
          fetchRuns();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getSourceConfig = (source: string) => {
    return SOURCE_CONFIG[source] || { 
      label: source, 
      icon: RefreshCw, 
      color: "text-muted-foreground" 
    };
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
            <CheckCircle className="h-3 w-3 mr-1" />
            OK
          </Badge>
        );
      case "completed_with_errors":
        return (
          <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30">
            <XCircle className="h-3 w-3 mr-1" />
            Con errores
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30">
            <XCircle className="h-3 w-3 mr-1" />
            Error
          </Badge>
        );
      case "running":
      case "continuing":
        return (
          <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/30">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            En progreso
          </Badge>
        );
      default:
        return (
          <Badge variant="outline">
            {status}
          </Badge>
        );
    }
  };

  const getProgressPercent = (sync: SyncRun): number => {
    const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null) 
      ? sync.checkpoint as Record<string, unknown> 
      : null;
    
    // If we have runningTotal, estimate based on typical patterns
    const runningTotal = checkpoint?.runningTotal as number || sync.total_fetched || 0;
    
    // Estimate progress - cap at 95% until actually complete
    if (sync.status === 'completed') return 100;
    if (runningTotal === 0) return 5;
    
    // Rough estimate: assume ~1000 transactions max for most syncs
    const estimated = Math.min(95, Math.round((runningTotal / 1000) * 100));
    return Math.max(estimated, 10);
  };

  const getElapsedTime = (startedAt: string): string => {
    const startDate = new Date(startedAt);
    const now = new Date();
    const diffMs = now.getTime() - startDate.getTime();
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    
    if (minutes >= 15) return `${minutes}m ⚠️ (posiblemente atascado)`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const handleCancelSync = async (source: string) => {
    setIsCancelling(true);
    try {
      // STEP 1: Force cancel via database update for ALL running syncs
      const { data: runningData, error: runningError } = await supabase
        .from('sync_runs')
        .update({
          status: 'canceled',
          completed_at: new Date().toISOString(),
          error_message: 'Cancelado por el usuario'
        })
        .in('status', ['running', 'continuing'])
        .select();
      
      if (runningError) {
        console.error('Error cancelling via DB:', runningError);
      }
      
      const cancelledCount = runningData?.length || 0;
      
      // STEP 2: Also call edge functions to stop any in-flight processing
      if (source === 'all') {
        // Call cancel endpoints in parallel but don't wait for all
        Promise.allSettled([
          invokeWithAdminKey<{ success: boolean }, { forceCancel: boolean }>('fetch-stripe', { forceCancel: true }).catch(() => {}),
          invokeWithAdminKey<{ success: boolean }, { forceCancel: boolean }>('fetch-paypal', { forceCancel: true }).catch(() => {}),
          invokeWithAdminKey<{ ok: boolean }, { forceCancel: boolean }>('sync-ghl', { forceCancel: true }).catch(() => {}),
          invokeWithAdminKey<{ ok: boolean }, { forceCancel: boolean }>('sync-manychat', { forceCancel: true }).catch(() => {}),
        ]);
        
        toast.success('Sincronizaciones canceladas', {
          description: `${cancelledCount} proceso(s) marcados como cancelados`,
        });
      } else if (source === 'bulk_unify') {
        // For bulk_unify, just update the database - the edge function checks status
        toast.success('Unificación Masiva cancelada', {
          description: 'El proceso se detendrá en el próximo chunk',
        });
      } else {
        // Cancel specific source
        let endpoint = 'fetch-stripe';
        if (source === 'paypal') endpoint = 'fetch-paypal';
        else if (source === 'ghl') endpoint = 'sync-ghl';
        else if (source === 'manychat') endpoint = 'sync-manychat';
        
        invokeWithAdminKey<{ success: boolean }, { forceCancel: boolean }>(endpoint, { forceCancel: true }).catch(() => {});
        
        toast.success('Sync cancelado', {
          description: `Sincronización de ${getSourceConfig(source).label} cancelada`,
        });
      }
      
      // Refresh the list
      fetchRuns();
      
    } catch (error) {
      console.error('Cancel sync error:', error);
      toast.error('Error al cancelar', {
        description: error instanceof Error ? error.message : 'Error desconocido',
      });
    } finally {
      setIsCancelling(false);
    }
  };

  // ============= FORCE KILL ALL ZOMBIES (Emergency Kill Switch) =============
  const handleForceKillAllZombies = async () => {
    setIsForceKilling(true);
    try {
      // Directly update ALL running/continuing syncs to failed
      const { data: killedSyncs, error } = await supabase
        .from('sync_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: '⚠️ Manual Kill - Forzado por Admin'
        })
        .in('status', ['running', 'continuing', 'paused'])
        .select('id, source');
      
      if (error) {
        console.error('Error killing zombies:', error);
        toast.error('Error al desbloquear', {
          description: error.message,
        });
        return;
      }

      const killedCount = killedSyncs?.length || 0;
      
      toast.success(`☠️ ${killedCount} proceso(s) eliminados`, {
        description: 'Todos los syncs zombies han sido marcados como fallidos. Ahora puedes reiniciar.',
      });

      // Refresh the list
      fetchRuns();
      
    } catch (error) {
      console.error('Force kill error:', error);
      toast.error('Error al forzar desbloqueo', {
        description: error instanceof Error ? error.message : 'Error desconocido',
      });
    } finally {
      setIsForceKilling(false);
    }
  };

  // ============= RESUME FAILED SYNC =============
  const handleResumeSync = async (sync: SyncRun) => {
    setIsResuming(sync.id);
    try {
      const checkpoint = sync.checkpoint as Record<string, unknown> | null;
      const cursor = checkpoint?.cursor as string | undefined;
      
      if (!cursor) {
        toast.error('No hay punto de reanudación', {
          description: 'El sync no tiene un cursor guardado para continuar.',
        });
        return;
      }

      // Map source to edge function
      let endpoint = '';
      let payload: Record<string, unknown> = {};
      
      switch (sync.source) {
        case 'stripe':
          endpoint = 'fetch-stripe';
          payload = { resumeFromCursor: cursor };
          break;
        case 'paypal':
          endpoint = 'fetch-paypal';
          payload = { resumeFromCursor: cursor };
          break;
        case 'ghl':
          endpoint = 'sync-ghl';
          payload = { resumeFromCursor: cursor };
          break;
        case 'manychat':
          endpoint = 'sync-manychat';
          payload = { resumeFromCursor: cursor };
          break;
        default:
          toast.error('Fuente no soportada', {
            description: `No se puede reanudar syncs de ${sync.source}`,
          });
          return;
      }

      // Mark old sync as superseded
      await supabase
        .from('sync_runs')
        .update({
          error_message: `${sync.error_message || ''} → Reanudado en nuevo sync`
        })
        .eq('id', sync.id);

      // Start new sync with resume cursor
      const result = await invokeWithAdminKey<{ success: boolean; run_id?: string }>(endpoint, payload);
      
      if (result?.success || result?.run_id) {
        toast.success('Sync reanudado', {
          description: `Continuando desde cursor guardado (${(checkpoint?.runningTotal as number || 0).toLocaleString()} procesados)`,
        });
      } else {
        toast.success('Sync iniciado', {
          description: 'Verificando si continúa desde el cursor...',
        });
      }
      
      fetchRuns();
      
    } catch (error) {
      console.error('Resume sync error:', error);
      toast.error('Error al reanudar', {
        description: error instanceof Error ? error.message : 'Error desconocido',
      });
    } finally {
      setIsResuming(null);
    }
  };

  const formatDuration = (start: string, end: string | null) => {
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const diffMs = endDate.getTime() - startDate.getTime();
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  };

  const hasAnySyncs = activeSyncs.length > 0 || recentRuns.length > 0 || failedResumable.length > 0;
  const hasErrors = recentRuns.some(r => r.error_message || r.status === 'failed') || failedResumable.length > 0;
  const hasPotentialZombies = activeSyncs.some(sync => {
    const startDate = new Date(sync.started_at);
    const now = new Date();
    const diffMinutes = (now.getTime() - startDate.getTime()) / (1000 * 60);
    return diffMinutes > 10; // More than 10 minutes = potential zombie
  });

  // ALWAYS show the panel so user knows the system is monitoring
  // Only hide the detailed content when there's nothing to show

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <RefreshCw className={`h-4 w-4 text-primary ${activeSyncs.length > 0 ? 'animate-spin' : ''}`} />
          <span className="text-sm font-medium text-foreground">
            Estado de Sincronización
          </span>
          {activeSyncs.length > 0 && (
            <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/30 text-xs">
              {activeSyncs.length} activo{activeSyncs.length > 1 ? 's' : ''}
            </Badge>
          )}
          {hasPotentialZombies && (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-xs animate-pulse">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Posible zombie
            </Badge>
          )}
          {hasErrors && (
            <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30 text-xs">
              <XCircle className="h-3 w-3 mr-1" />
              Errores
            </Badge>
          )}
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-border/50">
          {/* IDLE STATE - No syncs running */}
          {!hasAnySyncs && (
            <div className="p-6 text-center">
              <div className="flex flex-col items-center gap-3">
                <div className="p-3 rounded-full bg-zinc-800/50">
                  <CheckCircle className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Sistema en reposo</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    No hay sincronizaciones activas. Inicia una desde las tarjetas de arriba.
                  </p>
                </div>
                <Badge variant="outline" className="bg-zinc-800/50 text-muted-foreground border-zinc-700 text-xs mt-2">
                  <Clock className="h-3 w-3 mr-1" />
                  Monitoreando cada 5s
                </Badge>
              </div>
            </div>
          )}

          {/* Active syncs */}
          {activeSyncs.length > 0 && (
            <div className="p-4 space-y-3 bg-blue-500/5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">En progreso</p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCancelSync('all')}
                    disabled={isCancelling}
                    className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
                  >
                    {isCancelling ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <StopCircle className="h-3 w-3 mr-1" />
                    )}
                    Cancelar todo
                  </Button>
                  
                  {/* KILL SWITCH - Emergency button */}
                  {hasPotentialZombies && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isForceKilling}
                          className="h-7 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border border-amber-500/30"
                        >
                          {isForceKilling ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Skull className="h-3 w-3 mr-1" />
                          )}
                          ⚠️ Forzar Desbloqueo
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="bg-card border-border">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="flex items-center gap-2 text-amber-400">
                            <Skull className="h-5 w-5" />
                            ¿Forzar desbloqueo de TODOS los syncs?
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-muted-foreground">
                            Esta acción marcará <strong>TODOS</strong> los procesos en estado "running" o "continuing" como <strong>fallidos</strong>.
                            <br /><br />
                            Usa esto solo si los syncs están realmente colgados y no responden al botón "Cancelar todo".
                            <br /><br />
                            <span className="text-amber-400">Después de esto podrás reiniciar los syncs normalmente.</span>
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-border">Cancelar</AlertDialogCancel>
                          <AlertDialogAction 
                            onClick={handleForceKillAllZombies}
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                          >
                            <Skull className="h-4 w-4 mr-2" />
                            Sí, matar zombies
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
              {activeSyncs.map((sync) => {
                const config = getSourceConfig(sync.source);
                const Icon = config.icon;
                const progress = getProgressPercent(sync);
                const elapsed = getElapsedTime(sync.started_at);
                
                // Extract detailed info from checkpoint
                const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null) 
                  ? sync.checkpoint as Record<string, unknown> 
                  : null;
                
                const page = checkpoint?.page as number | undefined;
                const chunkIndex = checkpoint?.chunkIndex as number | undefined;
                const totalChunks = checkpoint?.totalChunks as number | undefined;
                const runningTotal = checkpoint?.runningTotal as number | undefined;
                const lastActivity = checkpoint?.lastActivity as string | undefined;
                
                // Build dynamic status message
                const getStatusMessage = () => {
                  const fetched = sync.total_fetched || runningTotal || 0;
                  const inserted = sync.total_inserted || 0;
                  
                  if (fetched === 0 && inserted === 0) {
                    return 'Iniciando conexión...';
                  }
                  
                  const parts = [];
                  
                  // Show chunk/batch progress
                  if (totalChunks && chunkIndex !== undefined) {
                    parts.push(`Lote ${chunkIndex + 1}/${totalChunks}`);
                  } else if (page) {
                    parts.push(`Página ${page}`);
                  }
                  
                  // Show counts
                  if (fetched > 0) parts.push(`${fetched.toLocaleString()} procesados`);
                  if (inserted > 0) parts.push(`${inserted.toLocaleString()} insertados`);
                  
                  return parts.length > 0 ? parts.join(' • ') : 'Procesando...';
                };
                
                // Check for stale sync (no activity in 2+ minutes)
                const isStale = lastActivity 
                  ? (Date.now() - new Date(lastActivity).getTime()) > 2 * 60 * 1000 
                  : false;
                
                return (
                  <div key={sync.id} className="bg-zinc-900/50 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {/* Pulsing indicator */}
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                        <Icon className={`h-4 w-4 ${config.color}`} />
                        <span className="text-sm font-medium">{config.label}</span>
                        {isStale && (
                          <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">
                            Sin actividad
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">{elapsed}</span>
                    </div>
                    
                    {/* Progress bar with pulse animation */}
                    <div className="relative">
                      <Progress value={progress} className="h-2 bg-zinc-800" />
                      <div 
                        className="absolute top-0 left-0 h-2 bg-blue-400/30 rounded-full animate-pulse"
                        style={{ width: `${Math.min(progress + 5, 100)}%` }}
                      />
                    </div>
                    
                    {/* Dynamic status message */}
                    <p className="text-xs text-muted-foreground">
                      {getStatusMessage()}
                    </p>
                    
                    {/* Inline error display */}
                    {sync.error_message && (
                      <div className="mt-2 p-2 bg-red-500/10 rounded border border-red-500/20">
                        <p className="text-xs text-red-400">{sync.error_message}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent completed syncs */}
          {recentRuns.length > 0 && (
            <div className="divide-y divide-border/30">
              <div className="px-4 py-2 bg-muted/20">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Completados (última hora)
                </p>
              </div>
              {recentRuns.map((sync) => {
                const config = getSourceConfig(sync.source);
                const Icon = config.icon;
                
                return (
                  <div key={sync.id} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Icon className={`h-4 w-4 ${config.color} flex-shrink-0`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{config.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {sync.completed_at && format(new Date(sync.completed_at), "HH:mm", { locale: es })}
                          {' • '}
                          {formatDuration(sync.started_at, sync.completed_at)}
                        </p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="text-right">
                        <p className="text-sm font-medium">
                          {sync.total_fetched?.toLocaleString() || 0}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {sync.total_inserted ? `${sync.total_inserted.toLocaleString()} nuevos` : 'sincronizados'}
                        </p>
                      </div>
                      {getStatusBadge(sync.status)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ============= RESUMABLE FAILED SYNCS ============= */}
          {failedResumable.length > 0 && (
            <div className="divide-y divide-border/30 bg-amber-500/5">
              <div className="px-4 py-2 bg-amber-500/10">
                <p className="text-xs font-medium text-amber-400 uppercase tracking-wider flex items-center gap-2">
                  <PlayCircle className="h-3 w-3" />
                  Syncs Reanudables
                </p>
              </div>
              {failedResumable.map((sync) => {
                const config = getSourceConfig(sync.source);
                const Icon = config.icon;
                const checkpoint = sync.checkpoint as Record<string, unknown> | null;
                const runningTotal = checkpoint?.runningTotal as number || sync.total_fetched || 0;
                const lastActivity = checkpoint?.lastActivity as string | undefined;
                
                return (
                  <div key={sync.id} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Icon className={`h-4 w-4 ${config.color} flex-shrink-0`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{config.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {runningTotal.toLocaleString()} procesados • 
                          {lastActivity && ` última actividad ${formatDistanceToNow(new Date(lastActivity), { locale: es, addSuffix: true })}`}
                        </p>
                        {sync.error_message && (
                          <p className="text-xs text-red-400 truncate mt-0.5">{sync.error_message}</p>
                        )}
                      </div>
                    </div>
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleResumeSync(sync)}
                      disabled={isResuming === sync.id}
                      className="h-8 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                    >
                      {isResuming === sync.id ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <PlayCircle className="h-3 w-3 mr-1" />
                      )}
                      Reanudar
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Error messages from recent runs */}
          {recentRuns.filter(r => r.error_message).map((sync) => (
            <div key={`error-${sync.id}`} className="px-4 py-2 bg-red-500/5 text-xs text-red-400 border-t border-red-500/20">
              <span className="font-medium">{getSourceConfig(sync.source).label}:</span>{' '}
              {sync.error_message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
