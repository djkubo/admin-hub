import { useState, useCallback, useRef, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";

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

interface PersistedState {
  hours_lookback: HoursLookback;
  starting_after?: string;
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
    // Expire after 1 hour
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

function clearResult() {
  localStorage.removeItem(STORAGE_KEY_RESULT);
}

export function useSmartRecovery() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<AggregatedResult | null>(null);
  const [selectedRange, setSelectedRange] = useState<HoursLookback | null>(null);
  const [progress, setProgress] = useState<{ batch: number; message: string } | null>(null);
  const [hasPendingResume, setHasPendingResume] = useState(false);
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
      // Also restore partial results if available
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

    // Check for pending state to resume
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

        const data = await invokeWithAdminKey("recover-revenue", { hours_lookback, starting_after });

        const batchResult = data as RecoveryResult;

        // Aggregate results
        aggregated.succeeded.push(...batchResult.succeeded);
        aggregated.failed.push(...batchResult.failed);
        aggregated.skipped.push(...batchResult.skipped);
        aggregated.summary.total_invoices += batchResult.summary.processed_invoices;
        aggregated.summary.total_recovered += batchResult.summary.total_recovered;
        aggregated.summary.total_failed_amount += batchResult.summary.total_failed_amount;
        aggregated.summary.total_skipped_amount += batchResult.summary.total_skipped_amount;
        aggregated.summary.batches_processed = batchNum;

        // Update result in real-time
        setResult({ ...aggregated });

        // Check if there's more to process
        if (batchResult.summary.is_partial && batchResult.summary.next_starting_after) {
          starting_after = batchResult.summary.next_starting_after;
          hasMore = true;
          
          // Save state for resume capability
          saveState({
            hours_lookback,
            starting_after,
            aggregated: { ...aggregated },
            timestamp: Date.now(),
          });
          
          // Small delay between batches
          await new Promise(r => setTimeout(r, 1000));
        } else {
          hasMore = false;
        }
      }

      const { summary } = aggregated;
      
      // Clear pending state on completion
      clearState();
      // Save final result
      saveResult(aggregated);
      
      if (abortRef.current) {
        // Keep state for resume if cancelled
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
      
      // Save state for resume on error
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
  }, []);

  const dismissPendingResume = useCallback(() => {
    clearState();
    setHasPendingResume(false);
  }, []);

  const exportToCSV = useCallback(() => {
    if (!result) return;

    const rows: string[] = [];
    
    // Header
    rows.push("Tipo,Invoice ID,Email,Monto,Moneda,Detalle");

    // Succeeded
    result.succeeded.forEach((item) => {
      rows.push(`Recuperado,${item.invoice_id},${item.customer_email || "N/A"},${(item.amount_recovered / 100).toFixed(2)},${item.currency.toUpperCase()},${item.payment_method_used}`);
    });

    // Failed
    result.failed.forEach((item) => {
      rows.push(`Fallido,${item.invoice_id},${item.customer_email || "N/A"},${(item.amount_due / 100).toFixed(2)},${item.currency.toUpperCase()},"${item.error} (${item.cards_tried} tarjetas probadas)"`);
    });

    // Skipped
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
    setHasPendingResume(false);
  }, []);

  return {
    isRunning,
    result,
    selectedRange,
    progress,
    hasPendingResume,
    runRecovery,
    resumeRecovery,
    cancelRecovery,
    dismissPendingResume,
    exportToCSV,
    clearResult: clearResults,
  };
}
