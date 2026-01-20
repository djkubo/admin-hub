import { useState, useCallback, useRef, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

export interface RecoverySuccessItem {
  invoice_id: string;
  customer_email: string | null;
  amount_recovered: number;
  currency: string;
  payment_method_used: string;
}

export interface RecoveryFailedItem {
  invoice_id: string;
  customer_email: string | null;
  amount_due: number;
  currency: string;
  error: string;
  cards_tried: number;
}

export interface RecoverySkippedItem {
  invoice_id: string;
  customer_email: string | null;
  amount_due: number;
  currency: string;
  reason: string;
  subscription_status?: string;
}

export interface RecoverySummary {
  total_invoices: number;
  processed_invoices: number;
  total_recovered: number;
  total_failed_amount: number;
  total_skipped_amount: number;
  currency: string;
  is_partial: boolean;
  remaining_invoices: number;
  next_starting_after?: string;
}

export interface RecoveryResult {
  succeeded: RecoverySuccessItem[];
  failed: RecoveryFailedItem[];
  skipped: RecoverySkippedItem[];
  summary: RecoverySummary;
}

export interface AggregatedResult {
  succeeded: RecoverySuccessItem[];
  failed: RecoveryFailedItem[];
  skipped: RecoverySkippedItem[];
  summary: {
    total_invoices: number;
    total_recovered: number;
    total_failed_amount: number;
    total_skipped_amount: number;
    currency: string;
    batches_processed: number;
  };
}

export type HoursLookback = 24 | 168 | 360 | 720 | 1440;

export const RECOVERY_RANGES: { hours: HoursLookback; label: string }[] = [
  { hours: 24, label: "Últimas 24h" },
  { hours: 168, label: "7 Días" },
  { hours: 360, label: "15 Días" },
  { hours: 720, label: "30 Días" },
  { hours: 1440, label: "60 Días" },
];

// Storage keys for persistence
const STORAGE_KEY_RESULT = "smart_recovery_result";
const STORAGE_KEY_STATE = "smart_recovery_state";
const STORAGE_KEY_BACKGROUND = "smart_recovery_background";

interface PersistedState {
  hours_lookback: HoursLookback;
  starting_after?: string;
  aggregated: AggregatedResult;
  timestamp: number;
}

interface BackgroundState {
  sync_run_id: string;
  hours_lookback: HoursLookback;
  started_at: string;
}

function saveState(state: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save recovery state:", e);
  }
}

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATE);
    if (!raw) return null;
    const state = JSON.parse(raw) as PersistedState;
    if (Date.now() - state.timestamp > 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY_STATE);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY_STATE);
}

function saveResult(result: AggregatedResult) {
  try {
    localStorage.setItem(STORAGE_KEY_RESULT, JSON.stringify({ result, timestamp: Date.now() }));
  } catch (e) {
    console.warn("Failed to save recovery result:", e);
  }
}

function loadResult(): AggregatedResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RESULT);
    if (!raw) return null;
    const { result, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY_RESULT);
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function clearResult() {
  localStorage.removeItem(STORAGE_KEY_RESULT);
}

function saveBackgroundState(state: BackgroundState) {
  try {
    localStorage.setItem(STORAGE_KEY_BACKGROUND, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save background state:", e);
  }
}

function loadBackgroundState(): BackgroundState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BACKGROUND);
    if (!raw) return null;
    const state = JSON.parse(raw) as BackgroundState;
    const startedAt = new Date(state.started_at).getTime();
    if (Date.now() - startedAt > 2 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY_BACKGROUND);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function clearBackgroundState() {
  localStorage.removeItem(STORAGE_KEY_BACKGROUND);
}

export function useSmartRecovery() {
  const [isRunning, setIsRunning] = useState(false);
  const [isBackgroundRunning, setIsBackgroundRunning] = useState(false);
  const [result, setResult] = useState<AggregatedResult | null>(null);
  const [selectedRange, setSelectedRange] = useState<HoursLookback | null>(null);
  const [progress, setProgress] = useState<{ batch: number; message: string } | null>(null);
  const [hasPendingResume, setHasPendingResume] = useState(false);
  const [backgroundSyncId, setBackgroundSyncId] = useState<string | null>(null);
  const abortRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  const startPolling = useCallback((syncRunId: string) => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
    }
    
    const poll = async () => {
      try {
        const { data: syncRun, error } = await supabase
          .from("sync_runs")
          .select("*")
          .eq("id", syncRunId)
          .single();
        
        if (error || !syncRun) {
          console.error("Error polling sync run:", error);
          return;
        }
        
        const checkpoint = syncRun.checkpoint as Record<string, unknown> | null;
        const metadata = syncRun.metadata as Record<string, unknown> | null;
        
        // Use checkpoint for real-time progress (updated per-invoice), fallback to metadata
        const progressData = checkpoint || metadata;
        
        if (progressData) {
          const processed = (progressData.processed as number) || 0;
          const recoveredAmt = (progressData.recovered_amount as number) || (progressData.recovered as number) || 0;
          const failedCount = (progressData.failed_count as number) || 0;
          const succeededCount = (progressData.succeeded_count as number) || 0;
          
          setProgress({
            batch: processed,
            message: `Procesando... ${processed} facturas (✅ ${succeededCount} | ❌ ${failedCount}) - $${recoveredAmt.toFixed(2)} recuperados`,
          });
        }
        
        if (syncRun.status === "completed" || syncRun.status === "partial" || syncRun.status === "failed") {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          setIsBackgroundRunning(false);
          setIsRunning(false);
          clearBackgroundState();
          
          if (syncRun.status === "failed") {
            toast({
              title: "Error en Smart Recovery",
              description: syncRun.error_message || "Error desconocido en proceso de fondo",
              variant: "destructive",
            });
            setProgress(null);
            return;
          }
          
          if (metadata) {
            const aggregated: AggregatedResult = {
              succeeded: (metadata.succeeded as RecoverySuccessItem[]) || [],
              failed: (metadata.failed as RecoveryFailedItem[]) || [],
              skipped: (metadata.skipped as RecoverySkippedItem[]) || [],
              summary: {
                total_invoices: syncRun.total_fetched || 0,
                total_recovered: ((metadata.recovered_amount as number) || 0) * 100,
                total_failed_amount: ((metadata.failed_amount as number) || 0) * 100,
                total_skipped_amount: ((metadata.skipped_amount as number) || 0) * 100,
                currency: "usd",
                batches_processed: 1,
              },
            };
            
            setResult(aggregated);
            saveResult(aggregated);
            
            toast({
              title: syncRun.status === "partial" ? "Smart Recovery Parcial" : "Smart Recovery Completado",
              description: `Recuperados: $${((metadata.recovered_amount as number) || 0).toFixed(2)}`,
            });
          }
          
          setProgress(null);
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    };
    
    poll();
    pollingRef.current = setInterval(poll, 3000);
  }, [toast]);

  // Load persisted result and check for background process on mount
  useEffect(() => {
    const savedResult = loadResult();
    if (savedResult) {
      setResult(savedResult);
    }
    const pendingState = loadState();
    if (pendingState) {
      setHasPendingResume(true);
      setSelectedRange(pendingState.hours_lookback);
      if (pendingState.aggregated.summary.batches_processed > 0) {
        setResult(pendingState.aggregated);
      }
    }
    
    const bgState = loadBackgroundState();
    if (bgState) {
      setBackgroundSyncId(bgState.sync_run_id);
      setSelectedRange(bgState.hours_lookback);
      setIsBackgroundRunning(true);
      startPolling(bgState.sync_run_id);
    }
    
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [startPolling]);

  const createEmptyAggregated = (): AggregatedResult => ({
    succeeded: [],
    failed: [],
    skipped: [],
    summary: {
      total_invoices: 0,
      total_recovered: 0,
      total_failed_amount: 0,
      total_skipped_amount: 0,
      currency: "usd",
      batches_processed: 0,
    },
  });

  const runRecoveryBackground = useCallback(async (hours_lookback: HoursLookback) => {
    setIsRunning(true);
    setIsBackgroundRunning(true);
    setSelectedRange(hours_lookback);
    setProgress({ batch: 0, message: "Iniciando Smart Recovery en segundo plano..." });

    try {
      // Use fetch directly with longer timeout for background mode
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/recover-revenue`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ hours_lookback, background: true }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const syncRunId = data?.sync_run_id;
      
      if (!syncRunId) {
        throw new Error("No sync_run_id received from background process");
      }

      setBackgroundSyncId(syncRunId);
      saveBackgroundState({
        sync_run_id: syncRunId,
        hours_lookback,
        started_at: new Date().toISOString(),
      });

      toast({
        title: "Smart Recovery Iniciado",
        description: "El proceso continúa en segundo plano. Puedes cerrar o recargar la página.",
      });

      startPolling(syncRunId);
    } catch (error) {
      console.error("Background recovery error:", error);
      setIsRunning(false);
      setIsBackgroundRunning(false);
      setProgress(null);
      
      toast({
        title: "Error al iniciar Smart Recovery",
        description: error instanceof Error ? error.message : "Error desconocido",
        variant: "destructive",
      });
    }
  }, [toast, startPolling]);

  const runRecovery = useCallback(async (hours_lookback: HoursLookback, resume = false) => {
    setIsRunning(true);
    setSelectedRange(hours_lookback);
    setHasPendingResume(false);
    abortRef.current = false;

    let aggregated: AggregatedResult;
    let starting_after: string | undefined;
    let batchNum = 0;

    if (resume) {
      const pendingState = loadState();
      if (pendingState && pendingState.hours_lookback === hours_lookback) {
        aggregated = pendingState.aggregated;
        starting_after = pendingState.starting_after;
        batchNum = pendingState.aggregated.summary.batches_processed;
        setResult(aggregated);
        setProgress({ batch: batchNum, message: `Reanudando desde lote ${batchNum + 1}...` });
        toast({
          title: "Reanudando Smart Recovery",
          description: `Continuando desde lote ${batchNum + 1} con ${aggregated.succeeded.length} ya recuperados`,
        });
      } else {
        aggregated = createEmptyAggregated();
        setResult(null);
      }
    } else {
      aggregated = createEmptyAggregated();
      setResult(null);
      clearState();
    }

    setProgress({ batch: batchNum, message: resume ? `Reanudando...` : "Iniciando Smart Recovery..." });

    let hasMore = true;

    try {
      while (hasMore && !abortRef.current) {
        batchNum++;
        setProgress({ 
          batch: batchNum, 
          message: `Procesando lote ${batchNum}... (${aggregated.succeeded.length} recuperados)` 
        });

        const { data, error } = await supabase.functions.invoke("recover-revenue", {
          body: { hours_lookback, starting_after },
        });
        
        if (error) {
          throw new Error(error.message || "Error calling recover-revenue");
        }
        const batchResult = data as RecoveryResult;

        aggregated.succeeded.push(...batchResult.succeeded);
        aggregated.failed.push(...batchResult.failed);
        aggregated.skipped.push(...batchResult.skipped);
        aggregated.summary.total_invoices += batchResult.summary.processed_invoices;
        aggregated.summary.total_recovered += batchResult.summary.total_recovered;
        aggregated.summary.total_failed_amount += batchResult.summary.total_failed_amount;
        aggregated.summary.total_skipped_amount += batchResult.summary.total_skipped_amount;
        aggregated.summary.batches_processed = batchNum;

        setResult({ ...aggregated });

        if (batchResult.summary.is_partial && batchResult.summary.next_starting_after) {
          starting_after = batchResult.summary.next_starting_after;
          hasMore = true;
          
          saveState({
            hours_lookback,
            starting_after,
            aggregated: { ...aggregated },
            timestamp: Date.now(),
          });
          
          await new Promise(r => setTimeout(r, 1000));
        } else {
          hasMore = false;
        }
      }

      const { summary } = aggregated;
      
      clearState();
      saveResult(aggregated);
      
      if (abortRef.current) {
        if (hasMore) {
          saveState({
            hours_lookback,
            starting_after,
            aggregated: { ...aggregated },
            timestamp: Date.now(),
          });
          setHasPendingResume(true);
        }
        toast({
          title: "Smart Recovery Pausado",
          description: `Parcial: Recuperados $${(summary.total_recovered / 100).toFixed(2)} en ${batchNum} lotes. Puedes reanudar.`,
        });
      } else {
        toast({
          title: "Smart Recovery Completado",
          description: `Recuperados: $${(summary.total_recovered / 100).toFixed(2)} | Fallidos: $${(summary.total_failed_amount / 100).toFixed(2)} | Lotes: ${batchNum}`,
        });
      }

      return aggregated;
    } catch (error) {
      console.error("Smart Recovery error:", error);
      const errMsg = error instanceof Error ? error.message : "Error desconocido";
      
      if (aggregated.summary.batches_processed > 0) {
        saveState({
          hours_lookback,
          starting_after,
          aggregated: { ...aggregated },
          timestamp: Date.now(),
        });
        setHasPendingResume(true);
        saveResult(aggregated);
        
        toast({
          title: "Error en Smart Recovery (Puedes Reanudar)",
          description: `Recuperados: $${(aggregated.summary.total_recovered / 100).toFixed(2)} antes del error. ${errMsg}`,
          variant: "destructive",
        });
        return aggregated;
      }
      
      toast({
        title: "Error en Smart Recovery",
        description: errMsg,
        variant: "destructive",
      });
      throw error;
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  }, [toast]);

  const resumeRecovery = useCallback(async () => {
    const pendingState = loadState();
    if (pendingState) {
      return runRecovery(pendingState.hours_lookback, true);
    }
  }, [runRecovery]);

  const cancelRecovery = useCallback(() => {
    abortRef.current = true;
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setIsBackgroundRunning(false);
  }, []);

  const dismissPendingResume = useCallback(() => {
    clearState();
    setHasPendingResume(false);
  }, []);

  const exportToCSV = useCallback(() => {
    if (!result) return;

    const rows: string[] = [];
    
    rows.push("Tipo,Invoice ID,Email,Monto,Moneda,Detalle");

    result.succeeded.forEach((item) => {
      rows.push(`Recuperado,${item.invoice_id},${item.customer_email || "N/A"},${(item.amount_recovered / 100).toFixed(2)},${item.currency.toUpperCase()},${item.payment_method_used}`);
    });

    result.failed.forEach((item) => {
      rows.push(`Fallido,${item.invoice_id},${item.customer_email || "N/A"},${(item.amount_due / 100).toFixed(2)},${item.currency.toUpperCase()},"${item.error} (${item.cards_tried} tarjetas probadas)"`);
    });

    result.skipped.forEach((item) => {
      rows.push(`Omitido,${item.invoice_id},${item.customer_email || "N/A"},${(item.amount_due / 100).toFixed(2)},${item.currency.toUpperCase()},${item.reason}`);
    });

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
  }, [result, toast]);

  const clearResults = useCallback(() => {
    setResult(null);
    setSelectedRange(null);
    clearState();
    clearResult();
    clearBackgroundState();
    setHasPendingResume(false);
    setBackgroundSyncId(null);
  }, []);

  return {
    isRunning,
    isBackgroundRunning,
    result,
    selectedRange,
    progress,
    hasPendingResume,
    backgroundSyncId,
    runRecovery,
    runRecoveryBackground,
    resumeRecovery,
    cancelRecovery,
    dismissPendingResume,
    exportToCSV,
    clearResult: clearResults,
  };
}
