import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Check, X, RefreshCw, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import type { Json } from "@/integrations/supabase/types";

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

// Stale threshold - same as backend (30 minutes)
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export function SyncStatusBanner() {
  const [runningSyncs, setRunningSyncs] = useState<SyncRun[]>([]);
  const [recentCompleted, setRecentCompleted] = useState<SyncRun[]>([]);
  const [staleSyncs, setStaleSyncs] = useState<Set<string>>(new Set());

  const fetchSyncStatus = useCallback(async () => {
    const now = Date.now();
    const staleThreshold = new Date(now - STALE_THRESHOLD_MS).toISOString();
    
    // Get running syncs (including "continuing" status for auto-pagination)
    const { data: running } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["running", "continuing"])
      .order("started_at", { ascending: false });

    // Filter out stale syncs and mark them
    const activeSyncs: SyncRun[] = [];
    const newStaleSyncs = new Set<string>();
    
    for (const sync of (running || []) as SyncRun[]) {
      const startedAt = new Date(sync.started_at).getTime();
      const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null) 
        ? sync.checkpoint as Record<string, unknown> 
        : null;
      const lastHeartbeat = checkpoint?.lastHeartbeat 
        ? new Date(checkpoint.lastHeartbeat as string).getTime()
        : startedAt;
      
      // Check if stale (no heartbeat for 30 minutes)
      if (now - lastHeartbeat > STALE_THRESHOLD_MS) {
        newStaleSyncs.add(sync.id);
      } else {
        activeSyncs.push(sync);
      }
    }

    // Get recently completed (last 5 minutes) or failed
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const { data: completed } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["completed", "error", "failed"])
      .gte("completed_at", fiveMinutesAgo)
      .order("completed_at", { ascending: false })
      .limit(5);

    setRunningSyncs(activeSyncs as SyncRun[]);
    setRecentCompleted((completed || []) as SyncRun[]);
    setStaleSyncs(newStaleSyncs);
  }, []);

  useEffect(() => {
    fetchSyncStatus();
    
    // Poll every 3 seconds
    const interval = setInterval(fetchSyncStatus, 3000);
    
    return () => clearInterval(interval);
  }, [fetchSyncStatus]);

  // Auto-dismiss completed syncs after showing
  useEffect(() => {
    if (recentCompleted.length > 0) {
      const timer = setTimeout(() => {
        setRecentCompleted([]);
      }, 10000); // Hide after 10 seconds
      return () => clearTimeout(timer);
    }
  }, [recentCompleted]);

  if (runningSyncs.length === 0 && recentCompleted.length === 0 && staleSyncs.size === 0) {
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

  // Estimate progress based on checkpoint data or fetched contacts
  const getEstimatedProgress = (sync: SyncRun) => {
    const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null) 
      ? sync.checkpoint as Record<string, unknown> 
      : null;
    
    // For chunked syncs (PayPal), use chunk progress
    if (checkpoint?.chunksTotal && checkpoint?.chunkIndex) {
      const total = checkpoint.chunksTotal as number;
      const current = checkpoint.chunkIndex as number;
      return Math.min((current / total) * 100, 99);
    }
    
    // For paginated syncs (Stripe/GHL), use page progress
    if (checkpoint?.page) {
      const page = checkpoint.page as number;
      // Estimate based on typical sync sizes
      const estimatedTotalPages = sync.source === 'ghl' ? 1500 : 100; // 150k GHL contacts / 100 per page
      return Math.min((page / estimatedTotalPages) * 100, 99);
    }
    
    // If we have fetched data, use that as indicator
    if (sync.total_fetched && sync.total_fetched > 0) {
      const estimatedTotal = sync.source === 'ghl' ? 150000 : 5000;
      return Math.min((sync.total_fetched / estimatedTotal) * 100, 99);
    }
    
    // Fallback: time-based estimate
    const startTime = new Date(sync.started_at).getTime();
    const elapsed = Date.now() - startTime;
    const estimatedTotal = sync.source === 'ghl' ? 60 * 60 * 1000 : 15 * 60 * 1000;
    return Math.min((elapsed / estimatedTotal) * 100, 95);
  };

  const getProgressDetails = (sync: SyncRun) => {
    const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null) 
      ? sync.checkpoint as Record<string, unknown> 
      : null;
    const parts: string[] = [];
    
    if (checkpoint?.page) {
      parts.push(`página ${checkpoint.page}`);
    }
    if (checkpoint?.chunkIndex && checkpoint?.chunksTotal) {
      parts.push(`chunk ${checkpoint.chunkIndex}/${checkpoint.chunksTotal}`);
    }
    if (sync.total_fetched) {
      parts.push(`${sync.total_fetched.toLocaleString()} descargados`);
    }
    if (sync.total_inserted) {
      parts.push(`${sync.total_inserted.toLocaleString()} nuevos`);
    }
    if (sync.total_updated) {
      parts.push(`${sync.total_updated.toLocaleString()} actualizados`);
    }
    
    return parts.length > 0 ? parts.join(' • ') : '';
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {/* Warning for stale syncs (hidden after a while) */}
      {staleSyncs.size > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                {staleSyncs.size} sync(s) sin respuesta
              </p>
              <p className="text-xs text-muted-foreground">
                Se marcarán como fallidos automáticamente
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Running syncs */}
      {runningSyncs.map((sync) => {
        const progress = getEstimatedProgress(sync);
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
                  {sync.status === 'continuing' && 
                    <span className="ml-1 text-xs text-primary">(paginando)</span>
                  }
                </p>
                <p className="text-xs text-muted-foreground">
                  Iniciado {formatDistanceToNow(new Date(sync.started_at), { 
                    addSuffix: true, 
                    locale: es 
                  })}
                  {details && ` • ${details}`}
                </p>
                {/* Progress bar */}
                <div className="mt-2 h-1.5 w-full bg-primary/20 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
              <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin" />
            </div>
          </div>
        );
      })}

      {/* Recently completed syncs */}
      {recentCompleted.map((sync) => (
        <div
          key={sync.id}
          className={`rounded-lg px-4 py-3 shadow-lg backdrop-blur-sm transition-all ${
            sync.status === "completed"
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
              <p className="text-xs text-muted-foreground">
                {sync.total_inserted
                  ? `${sync.total_inserted.toLocaleString()} nuevos`
                  : ""}
                {sync.total_updated
                  ? ` • ${sync.total_updated.toLocaleString()} actualizados`
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
