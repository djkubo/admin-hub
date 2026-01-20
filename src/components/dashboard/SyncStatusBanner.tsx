import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Check, X, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";

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
}

export function SyncStatusBanner() {
  const [runningSyncs, setRunningSyncs] = useState<SyncRun[]>([]);
  const [recentCompleted, setRecentCompleted] = useState<SyncRun[]>([]);

  const fetchSyncStatus = async () => {
    // Get running syncs
    const { data: running } = await supabase
      .from("sync_runs")
      .select("*")
      .eq("status", "running")
      .order("started_at", { ascending: false });

    // Get recently completed (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: completed } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["completed", "error"])
      .gte("completed_at", fiveMinutesAgo)
      .order("completed_at", { ascending: false })
      .limit(5);

    setRunningSyncs(running || []);
    setRecentCompleted(completed || []);
  };

  useEffect(() => {
    fetchSyncStatus();
    
    // Poll every 3 seconds while there are running syncs
    const interval = setInterval(fetchSyncStatus, 3000);
    
    return () => clearInterval(interval);
  }, []);

  // Auto-dismiss completed syncs after showing
  useEffect(() => {
    if (recentCompleted.length > 0) {
      const timer = setTimeout(() => {
        setRecentCompleted([]);
      }, 10000); // Hide after 10 seconds
      return () => clearTimeout(timer);
    }
  }, [recentCompleted]);

  if (runningSyncs.length === 0 && recentCompleted.length === 0) {
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

  // Estimate progress based on time (GHL syncs take ~10-15 min for large datasets)
  const getEstimatedProgress = (sync: SyncRun) => {
    const startTime = new Date(sync.started_at).getTime();
    const elapsed = Date.now() - startTime;
    const estimatedTotal = 15 * 60 * 1000; // 15 minutes estimate
    const progress = Math.min((elapsed / estimatedTotal) * 100, 95);
    
    // If we have fetched data, use that as a better indicator
    if (sync.total_fetched && sync.total_fetched > 0) {
      // Estimate based on typical GHL contact counts (assume ~5000 contacts max)
      const estimatedTotal = 5000;
      return Math.min((sync.total_fetched / estimatedTotal) * 100, 95);
    }
    
    return progress;
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {/* Running syncs */}
      {runningSyncs.map((sync) => {
        const progress = getEstimatedProgress(sync);
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
                  Iniciado {formatDistanceToNow(new Date(sync.started_at), { 
                    addSuffix: true, 
                    locale: es 
                  })}
                  {sync.total_fetched ? ` • ${sync.total_fetched} descargados` : ""}
                  {sync.total_inserted ? ` • ${sync.total_inserted} nuevos` : ""}
                  {sync.total_updated ? ` • ${sync.total_updated} actualizados` : ""}
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
                  ? `${sync.total_inserted} nuevos`
                  : ""}
                {sync.total_updated
                  ? ` • ${sync.total_updated} actualizados`
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
