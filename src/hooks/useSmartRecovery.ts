import { useState, useCallback, useRef, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

export interface RecoveryCheckpoint {
  last_cursor: string | null;
  recovered_amount: number;
  failed_amount: number;
  skipped_amount: number;
  processed: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  lastActivity: string;
}

export interface RecoveryProgress {
  syncRunId: string;
  status: "running" | "completed" | "failed";
  checkpoint: RecoveryCheckpoint;
  startedAt: string;
  elapsedSeconds: number;
  isStale: boolean;
}

export type HoursLookback = 24 | 168 | 360 | 720 | 1440;

export const RECOVERY_RANGES: { hours: HoursLookback; label: string }[] = [
  { hours: 24, label: "Últimas 24h" },
  { hours: 168, label: "7 Días" },
  { hours: 360, label: "15 Días" },
  { hours: 720, label: "30 Días" },
  { hours: 1440, label: "60 Días" },
];

const POLL_INTERVAL_MS = 3000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function useSmartRecovery() {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  const [selectedRange, setSelectedRange] = useState<HoursLookback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const { toast } = useToast();

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Check for active recovery on mount
  useEffect(() => {
    checkForActiveRecovery();
  }, []);

  const checkForActiveRecovery = useCallback(async () => {
    try {
      const { data } = await supabase
        .from("sync_runs")
        .select("*")
        .eq("source", "smart_recovery")
        .eq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1);
      
      if (data?.[0]) {
        const run = data[0];
        const checkpoint = run.checkpoint as unknown as RecoveryCheckpoint | null;
        const metadata = run.metadata as unknown as Record<string, unknown> | null;
        
        if (checkpoint) {
          setIsRunning(true);
          setSelectedRange((metadata?.hours_lookback as HoursLookback) || 24);
          startPolling(run.id);
        }
      }
    } catch (err) {
      console.error("Failed to check for active recovery:", err);
    }
  }, []);

  const pollSyncRun = useCallback(async (syncRunId: string): Promise<boolean> => {
    try {
      const { data, error: fetchError } = await supabase
        .from("sync_runs")
        .select("*")
        .eq("id", syncRunId)
        .single();
      
      if (fetchError || !data) {
        console.error("Failed to poll sync run:", fetchError);
        return false;
      }

      const checkpoint = data.checkpoint as unknown as RecoveryCheckpoint | null;
      const startedAt = new Date(data.started_at).getTime();
      const lastActivity = checkpoint?.lastActivity
        ? new Date(checkpoint.lastActivity).getTime() 
        : startedAt;
      const isStale = Date.now() - lastActivity > STALE_THRESHOLD_MS;
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);

      setProgress({
        syncRunId: data.id,
        status: data.status as "running" | "completed" | "failed",
        checkpoint: checkpoint || {
          last_cursor: null,
          recovered_amount: 0,
          failed_amount: 0,
          skipped_amount: 0,
          processed: 0,
          succeeded_count: 0,
          failed_count: 0,
          skipped_count: 0,
          lastActivity: new Date().toISOString(),
        },
        startedAt: data.started_at,
        elapsedSeconds,
        isStale,
      });

      // Check if finished
      if (data.status === "completed" || data.status === "failed") {
        return true; // Stop polling
      }

      return false;
    } catch (err) {
      console.error("Poll error:", err);
      return false;
    }
  }, []);

  const startPolling = useCallback((syncRunId: string) => {
    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    // Initial poll
    pollSyncRun(syncRunId);

    // Start interval
    pollIntervalRef.current = setInterval(async () => {
      const shouldStop = await pollSyncRun(syncRunId);
      if (shouldStop) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        setIsRunning(false);
        
        // Show completion toast
        const currentProgress = await supabase
          .from("sync_runs")
          .select("status, checkpoint")
          .eq("id", syncRunId)
          .single();
        
        if (currentProgress.data) {
          const cp = currentProgress.data.checkpoint as unknown as RecoveryCheckpoint;
          if (currentProgress.data.status === "completed") {
            toast({
              title: "✅ Smart Recovery Completado",
              description: `Recuperados: $${cp.recovered_amount.toFixed(2)} | Fallidos: $${cp.failed_amount.toFixed(2)} | Procesados: ${cp.processed}`,
            });
          } else {
            toast({
              title: "❌ Smart Recovery Fallido",
              description: "El proceso terminó con errores. Revisa los logs.",
              variant: "destructive",
            });
          }
        }
      }
    }, POLL_INTERVAL_MS);
  }, [pollSyncRun, toast]);

  const runRecovery = useCallback(async (hours_lookback: HoursLookback) => {
    setIsRunning(true);
    setSelectedRange(hours_lookback);
    setError(null);
    setProgress(null);

    try {
      // Single call to backend - it will auto-continue
      const { data, error: invokeError } = await supabase.functions.invoke("recover-revenue", {
        body: { hours_lookback },
      });

      if (invokeError) {
        throw new Error(invokeError.message || "Error calling recover-revenue");
      }

      if (!data?.ok) {
        throw new Error(data?.error || "Unknown backend error");
      }

      const syncRunId = data.syncRunId;
      
      if (!syncRunId) {
        throw new Error("No syncRunId returned");
      }

      toast({
        title: "🚀 Smart Recovery Iniciado",
        description: `Procesando facturas de los últimos ${hours_lookback / 24} días en segundo plano...`,
      });

      // Start polling for progress
      startPolling(syncRunId);

    } catch (err) {
      console.error("Recovery error:", err);
      const errMsg = err instanceof Error ? err.message : "Error desconocido";
      setError(errMsg);
      setIsRunning(false);
      
      toast({
        title: "Error en Smart Recovery",
        description: errMsg,
        variant: "destructive",
      });
    }
  }, [startPolling, toast]);

  const cancelRecovery = useCallback(async () => {
    if (!progress?.syncRunId) return;

    try {
      await supabase
        .from("sync_runs")
        .update({ 
          status: "failed", 
          completed_at: new Date().toISOString(),
          error_message: "Cancelled by user",
        })
        .eq("id", progress.syncRunId);

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      setIsRunning(false);
      
      toast({
        title: "Recovery Cancelado",
        description: `Proceso detenido. Recuperados: $${progress.checkpoint.recovered_amount.toFixed(2)}`,
      });
    } catch (err) {
      console.error("Cancel error:", err);
    }
  }, [progress, toast]);

  const forceCancelStale = useCallback(async () => {
    if (!progress?.syncRunId) return;

    try {
      await supabase
        .from("sync_runs")
        .update({ 
          status: "failed", 
          completed_at: new Date().toISOString(),
          error_message: "Force cancelled - stale process",
        })
        .eq("id", progress.syncRunId);

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      setIsRunning(false);
      setProgress(null);
      
      toast({
        title: "Proceso Liberado",
        description: "El proceso atascado ha sido cancelado. Puedes iniciar uno nuevo.",
      });
    } catch (err) {
      console.error("Force cancel error:", err);
    }
  }, [progress, toast]);

  const clearProgress = useCallback(() => {
    setProgress(null);
    setError(null);
    setSelectedRange(null);
  }, []);

  const exportToCSV = useCallback(async () => {
    if (!progress?.syncRunId) return;

    try {
      // Fetch full run data
      const { data } = await supabase
        .from("sync_runs")
        .select("*")
        .eq("id", progress.syncRunId)
        .single();

      if (!data) return;

      const cp = data.checkpoint as unknown as RecoveryCheckpoint;
      
      const rows: string[] = [
        "Métrica,Valor",
        `Recuperado,$${cp.recovered_amount.toFixed(2)}`,
        `Fallido,$${cp.failed_amount.toFixed(2)}`,
        `Omitido,$${cp.skipped_amount.toFixed(2)}`,
        `Facturas Procesadas,${cp.processed}`,
        `Exitosas,${cp.succeeded_count}`,
        `Fallidas,${cp.failed_count}`,
        `Omitidas,${cp.skipped_count}`,
        `Fecha,${new Date().toISOString()}`,
      ];

      const csv = rows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `smart-recovery-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: "Reporte exportado",
        description: "El archivo CSV se ha descargado correctamente",
      });
    } catch (err) {
      console.error("Export error:", err);
    }
  }, [progress, toast]);

  return {
    isRunning,
    progress,
    selectedRange,
    error,
    runRecovery,
    cancelRecovery,
    forceCancelStale,
    clearProgress,
    exportToCSV,
  };
}
