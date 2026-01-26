import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Check, X, RefreshCw, AlertTriangle, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { invokeWithAdminKey } from "@/lib/adminApi";

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
}

// Stale threshold - 30 minutes
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export function SyncStatusBanner() {
  const [runningSyncs, setRunningSyncs] = useState<SyncRun[]>([]);
  const [staleSyncs, setStaleSyncs] = useState<SyncRun[]>([]);
  const [recentCompleted, setRecentCompleted] = useState<SyncRun[]>([]);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  const fetchSyncStatus = useCallback(async () => {
    const now = Date.now();

    // Get running syncs
    const { data: running } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["running", "continuing"])
      .order("started_at", { ascending: false });

    // Separate active vs stale
    const activeSyncs: SyncRun[] = [];
    const staleSyncsList: SyncRun[] = [];

    for (const sync of (running || []) as SyncRun[]) {
      const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null)
        ? sync.checkpoint as Record<string, unknown>
        : null;

      const lastActivity = checkpoint?.lastActivity
        ? new Date(checkpoint.lastActivity as string).getTime()
        : new Date(sync.started_at).getTime();

      if (now - lastActivity > STALE_THRESHOLD_MS) {
        staleSyncsList.push(sync);
      } else {
        activeSyncs.push(sync);
      }
    }

    // Get recently completed (last 10 seconds)
    const tenSecondsAgo = new Date(now - 10 * 1000).toISOString();
    const { data: completed } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["completed", "failed"])
      .gte("completed_at", tenSecondsAgo)
      .order("completed_at", { ascending: false })
      .limit(3);

    setRunningSyncs(activeSyncs);
    setStaleSyncs(staleSyncsList);
    setRecentCompleted((completed || []) as SyncRun[]);
  }, []);

  useEffect(() => {
    fetchSyncStatus();
    const interval = setInterval(fetchSyncStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchSyncStatus]);

  // Auto-dismiss completed after 10 seconds
  useEffect(() => {
    if (recentCompleted.length > 0) {
      const timer = setTimeout(() => {
        setRecentCompleted([]);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [recentCompleted]);

  const handleCleanupStale = async () => {
    setIsCleaningUp(true);
    try {
      // Mark all stale syncs as failed directly in DB
      const staleIds = staleSyncs.map(s => s.id);

      if (staleIds.length > 0) {
        const { error } = await supabase
          .from('sync_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Marcado como fallido manualmente (timeout)'
          })
          .in('id', staleIds);

        if (error) {
          toast.error('Error limpiando syncs');
        } else {
          toast.success(`${staleIds.length} syncs marcados como fallidos`);
          setStaleSyncs([]);
        }
      }
    } catch (e) {
      toast.error('Error limpiando syncs atascados');
    } finally {
      setIsCleaningUp(false);
    }
  };

  const handleCancelSync = async (syncRunId: string) => {
    try {
      const { error } = await invokeWithAdminKey('cancel-sync', { syncRunId });

      if (error) {
        toast.error('Error cancelando sync');
      } else {
        toast.success('Sync cancelado exitosamente');
        // Refresh sync status
        fetchSyncStatus();
      }
    } catch (e) {
      toast.error('Error cancelando sync');
    }
  };

  if (runningSyncs.length === 0 && staleSyncs.length === 0 && recentCompleted.length === 0) {
    return null;
  }

  const getSourceLabel = (source: string) => {
    const labels: Record<string, string> = {
      stripe: "Stripe",
      paypal: "PayPal",
      subscriptions: "Suscripciones",
      invoices: "Facturas",
      ghl: "GoHighLevel",
      manychat: "ManyChat",
    };
    return labels[source] || source;
  };

  const getProgressDetails = (sync: SyncRun) => {
    const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null)
      ? sync.checkpoint as Record<string, unknown>
      : null;
    const parts: string[] = [];

    if (checkpoint?.page) {
      parts.push(`página ${checkpoint.page}`);
    }
    if (sync.total_fetched) {
      parts.push(`${sync.total_fetched.toLocaleString()} descargados`);
    }
    if (sync.total_inserted) {
      parts.push(`${sync.total_inserted.toLocaleString()} nuevos`);
    }

    return parts.length > 0 ? parts.join(' • ') : '';
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {/* Stale syncs warning with cleanup button */}
      {staleSyncs.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {staleSyncs.length} sync(s) atascados
              </p>
              <p className="text-xs text-muted-foreground">
                Sin actividad por más de 30 minutos
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCleanupStale}
              disabled={isCleaningUp}
              className="text-amber-400 hover:text-amber-300 hover:bg-amber-500/20"
            >
              {isCleaningUp ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Active syncs */}
      {runningSyncs.map((sync) => {
        const details = getProgressDetails(sync);

        return (
          <div
            key={sync.id}
            className="bg-primary/10 border border-primary/30 rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Sincronizando {getSourceLabel(sync.source)}...
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(sync.started_at), { addSuffix: true, locale: es })}
                  {details && ` • ${details}`}
                </p>
              </div>
              <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin" />
            </div>
          </div>
        );
      })}

      {/* Recently completed/failed */}
      {recentCompleted.map((sync) => (
        <div
          key={sync.id}
          className={`rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm transition-all ${sync.status === "completed"
            ? "bg-green-500/10 border border-green-500/30"
            : "bg-destructive/10 border border-destructive/30"
            }`}
        >
          <div className="flex items-center gap-3">
            {sync.status === "completed" ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <X className="h-4 w-4 text-destructive" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {getSourceLabel(sync.source)}{" "}
                {sync.status === "completed" ? "completado" : "falló"}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {sync.total_inserted
                  ? `${sync.total_inserted.toLocaleString()} sincronizados`
                  : ""}
                {sync.error_message && (
                  <span className="text-destructive"> {sync.error_message}</span>
                )}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
