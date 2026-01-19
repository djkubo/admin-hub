import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

export interface RecoveryResult {
  succeeded: RecoverySuccessItem[];
  failed: RecoveryFailedItem[];
  skipped: RecoverySkippedItem[];
  summary: {
    total_invoices: number;
    total_recovered: number;
    total_failed_amount: number;
    total_skipped_amount: number;
    currency: string;
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

export function useSmartRecovery() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [selectedRange, setSelectedRange] = useState<HoursLookback | null>(null);
  const { toast } = useToast();

  const runRecovery = async (hours_lookback: HoursLookback) => {
    setIsRunning(true);
    setSelectedRange(hours_lookback);
    setResult(null);

    try {
      const { data, error } = await supabase.functions.invoke("recover-revenue", {
        body: { hours_lookback },
      });

      if (error) throw error;

      setResult(data as RecoveryResult);

      const { summary } = data as RecoveryResult;
      toast({
        title: "Smart Recovery Completado",
        description: `Recuperados: $${(summary.total_recovered / 100).toFixed(2)} | Fallidos: $${(summary.total_failed_amount / 100).toFixed(2)} | Omitidos: $${(summary.total_skipped_amount / 100).toFixed(2)}`,
      });

      return data as RecoveryResult;
    } catch (error) {
      console.error("Smart Recovery error:", error);
      const errMsg = error instanceof Error ? error.message : "Error desconocido";
      toast({
        title: "Error en Smart Recovery",
        description: errMsg,
        variant: "destructive",
      });
      throw error;
    } finally {
      setIsRunning(false);
    }
  };

  const exportToCSV = () => {
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
  };

  const clearResult = () => {
    setResult(null);
    setSelectedRange(null);
  };

  return {
    isRunning,
    result,
    selectedRange,
    runRecovery,
    exportToCSV,
    clearResult,
  };
}
