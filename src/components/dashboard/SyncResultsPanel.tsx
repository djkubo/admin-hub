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
  AlertTriangle
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
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeSyncs, setActiveSyncs] = useState<SyncRun[]>([]);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isForceKilling, setIsForceKilling] = useState(false);

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
      .in("status", ["completed", "completed_with_errors", "failed"])
      .gte("completed_at", oneHourAgo)
      .order("completed_at", { ascending: false })
      .limit(10);

    setRecentRuns((recent || []) as SyncRun[]);
  };

  useEffect(() => {
    fetchRuns();
    // OPTIMIZATION: Reduced polling frequency from 3s to 5s
    const interval = setInterval(fetchRuns, 5000);
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

  const formatDuration = (start: string, end: string | null) => {
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const diffMs = endDate.getTime() - startDate.getTime();
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  };

  const hasAnySyncs = activeSyncs.length > 0 || recentRuns.length > 0;
  const hasErrors = recentRuns.some(r => r.error_message || r.status === 'failed');
  const hasPotentialZombies = activeSyncs.some(sync => {
    const startDate = new Date(sync.started_at);
    const now = new Date();
    const diffMinutes = (now.getTime() - startDate.getTime()) / (1000 * 60);
    return diffMinutes > 10; // More than 10 minutes = potential zombie
  });

  if (!hasAnySyncs) {
    return null;
  }

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
                  
                  // Build detailed message
                  const parts: string[] = [];
                  
                  if (totalChunks && chunkIndex !== undefined) {
                    parts.push(`Lote ${chunkIndex + 1}/${totalChunks}`);
                  } else if (page) {
                    parts.push(`Página ${page}`);
                  }
                  
                  if (fetched > 0) {
                    parts.push(`${fetched.toLocaleString()} procesados`);
                  }
                  
                  if (inserted > 0 && inserted !== fetched) {
                    parts.push(`${inserted.toLocaleString()} insertados`);
                  }
                  
                  return parts.length > 0 ? parts.join(' • ') : 'Procesando...';
                };
                
                // Check if stale (no activity in 2 minutes)
                const isStale = lastActivity && (Date.now() - new Date(lastActivity).getTime() > 120000);
                
                return (
                  <div key={sync.id} className="space-y-2 p-3 bg-zinc-900/50 rounded-lg border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <Icon className={`h-4 w-4 ${config.color}`} />
                          <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                        </div>
                        <span className="text-sm font-medium text-white">{config.label}</span>
                        {sync.status === 'continuing' && (
                          <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                            Auto-encadenando
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>{elapsed}</span>
                      </div>
                    </div>
                    
                    {/* Dynamic status message */}
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      <span className={`text-sm ${isStale ? 'text-amber-400' : 'text-white'}`}>
                        {getStatusMessage()}
                      </span>
                      {isStale && (
                        <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/30">
                          Sin actividad
                        </Badge>
                      )}
                    </div>
                    
                    {/* Progress bar with pulse animation */}
                    <div className="relative">
                      <Progress value={progress} className="h-2" />
                      {progress < 100 && (
                        <div 
                          className="absolute top-0 left-0 h-2 bg-primary/30 rounded-full animate-pulse"
                          style={{ width: `${Math.min(progress + 10, 100)}%` }}
                        />
                      )}
                    </div>
                    
                    {/* Detailed stats row */}
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {sync.total_fetched?.toLocaleString() || 0} registros
                        {sync.total_inserted ? ` (${sync.total_inserted.toLocaleString()} nuevos)` : ''}
                      </span>
                      <span className="text-zinc-500">
                        {progress}% completado
                      </span>
                    </div>
                    
                    {/* Error inline if exists */}
                    {sync.error_message && (
                      <div className="mt-2 p-2 bg-red-500/10 rounded border border-red-500/30 text-xs text-red-400">
                        ⚠️ {sync.error_message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ALWAYS show kill switch if no active syncs but there might be zombies in DB */}
          {activeSyncs.length === 0 && (
            <div className="p-4 border-b border-border/30">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isForceKilling}
                    className="w-full text-xs text-muted-foreground hover:text-amber-400 hover:border-amber-500/30"
                  >
                    {isForceKilling ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Skull className="h-3 w-3 mr-1" />
                    )}
                    ¿Syncs bloqueados? Forzar desbloqueo
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-border">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2 text-amber-400">
                      <Skull className="h-5 w-5" />
                      ¿Forzar desbloqueo de syncs zombies?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-muted-foreground">
                      Si los syncs parecen colgados o no puedes iniciar uno nuevo, usa esto para limpiar todos los procesos que quedaron en estado "running".
                      <br /><br />
                      <span className="text-amber-400">Esto no afecta los datos ya sincronizados.</span>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="border-border">Cancelar</AlertDialogCancel>
                    <AlertDialogAction 
                      onClick={handleForceKillAllZombies}
                      className="bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      <Skull className="h-4 w-4 mr-2" />
                      Sí, desbloquear
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}

          {/* Recent completed/failed */}
          {recentRuns.length > 0 && (
            <div className="divide-y divide-border/30">
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

          {/* Error messages */}
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
