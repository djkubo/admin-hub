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

// Standard response from backend
interface StandardRecoveryResponse {
  ok: boolean;
  status: string;
  syncRunId: string;
  processed: number;
  hasMore: boolean;
  nextCursor?: string;
  duration_ms: number;
  recovered_amount: number;
  failed_amount: number;
  skipped_amount: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  error?: string;
  succeeded: RecoverySuccessItem[];
  failed: RecoveryFailedItem[];
  skipped: RecoverySkippedItem[];
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

interface PersistedState {
  hours_lookback: HoursLookback;
  sync_run_id: string;
  cursor?: string;
  aggregated: AggregatedResult;
  timestamp: number;
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
    // Expire after 2 hours
    if (Date.now() - state.timestamp > 2 * 60 * 60 * 1000) {
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
    // Expire after 24 hours
    if (Date.now() - timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY_RESULT);
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function clearResultStorage() {
  localStorage.removeItem(STORAGE_KEY_RESULT);
}

export function useSmartRecovery() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<AggregatedResult | null>(null);
  const [selectedRange, setSelectedRange] = useState<HoursLookback | null>(null);
  const [progress, setProgress] = useState<{ batch: number; message: string } | null>(null);
  const [hasPendingResume, setHasPendingResume] = useState(false);
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null);
  const abortRef = useRef(false);
  const { toast } = useToast();

  // Load persisted result on mount
  useEffect(() => {
    const savedResult = loadResult();
    if (savedResult) {
      setResult(savedResult);
    }
    
    const pendingState = loadState();
    if (pendingState) {
      setHasPendingResume(true);
      setSelectedRange(pendingState.hours_lookback);
      setCurrentSyncId(pendingState.sync_run_id);
      if (pendingState.aggregated.summary.batches_processed > 0) {
        setResult(pendingState.aggregated);
      }
    }
  }, []);

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

  const runRecovery = useCallback(async (hours_lookback: HoursLookback, resume = false) => {
    setIsRunning(true);
    setSelectedRange(hours_lookback);
    setHasPendingResume(false);
    abortRef.current = false;

    let aggregated: AggregatedResult;
    let syncRunId: string | undefined;
    let cursor: string | undefined;
    let batchNum = 0;

    // Resume from saved state if applicable
    if (resume) {
      const pendingState = loadState();
      if (pendingState && pendingState.hours_lookback === hours_lookback) {
        aggregated = pendingState.aggregated;
        syncRunId = pendingState.sync_run_id;
        cursor = pendingState.cursor;
        batchNum = pendingState.aggregated.summary.batches_processed;
        setResult(aggregated);
        setCurrentSyncId(syncRunId);
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
    const MAX_BATCHES = 500; // Safety limit

    try {
      while (hasMore && !abortRef.current && batchNum < MAX_BATCHES) {
        batchNum++;
        setProgress({ 
          batch: batchNum, 
          message: `Procesando lote ${batchNum}... (✅ ${aggregated.succeeded.length} | ❌ ${aggregated.failed.length})` 
        });

        // Call backend with pagination
        const { data, error } = await supabase.functions.invoke<StandardRecoveryResponse>("recover-revenue", {
          body: { 
            hours_lookback, 
            cursor,
            sync_run_id: syncRunId,
          },
        });
        
        if (error) {
          throw new Error(error.message || "Error calling recover-revenue");
        }
        
        if (!data?.ok) {
          throw new Error(data?.error || "Unknown backend error");
        }

        // First response gives us the sync_run_id
        if (!syncRunId && data.syncRunId) {
          syncRunId = data.syncRunId;
          setCurrentSyncId(syncRunId);
        }

        // Aggregate batch results
        aggregated.succeeded.push(...data.succeeded);
        aggregated.failed.push(...data.failed);
        aggregated.skipped.push(...data.skipped);
        aggregated.summary.total_invoices += data.processed;
        aggregated.summary.total_recovered = data.recovered_amount * 100; // Convert back to cents for display
        aggregated.summary.total_failed_amount = data.failed_amount * 100;
        aggregated.summary.total_skipped_amount = data.skipped_amount * 100;
        aggregated.summary.batches_processed = batchNum;

        setResult({ ...aggregated });

        // Check if more to process
        hasMore = data.hasMore;
        cursor = data.nextCursor;

        // Save state for resume capability
        if (hasMore && syncRunId) {
          saveState({
            hours_lookback,
            sync_run_id: syncRunId,
            cursor,
            aggregated: { ...aggregated },
            timestamp: Date.now(),
          });
        }

        // Small delay between batches to be nice to Stripe API
        if (hasMore) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Completed successfully
      clearState();
      saveResult(aggregated);

      const { summary } = aggregated;
      
      if (abortRef.current) {
        // User cancelled - save state for resume
        if (hasMore && syncRunId) {
          saveState({
            hours_lookback,
            sync_run_id: syncRunId,
            cursor,
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
      
      // Save state for resume if we made progress
      if (aggregated.summary.batches_processed > 0 && syncRunId) {
        saveState({
          hours_lookback,
          sync_run_id: syncRunId,
          cursor,
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
  }, []);

  const dismissPendingResume = useCallback(() => {
    clearState();
    setHasPendingResume(false);
    setCurrentSyncId(null);
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

  const clearResult = useCallback(() => {
    setResult(null);
    setSelectedRange(null);
    clearState();
    clearResultStorage();
    setHasPendingResume(false);
    setCurrentSyncId(null);
  }, []);

  return {
    isRunning,
    isBackgroundRunning: false, // Deprecated - now uses foreground pagination
    result,
    selectedRange,
    progress,
    hasPendingResume,
    currentSyncId,
    runRecovery,
    runRecoveryBackground: runRecovery, // Same as runRecovery now
    resumeRecovery,
    cancelRecovery,
    dismissPendingResume,
    exportToCSV,
    clearResult,
  };
}
