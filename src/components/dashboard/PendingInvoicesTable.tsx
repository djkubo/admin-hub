import { useState } from "react";
import { ExternalLink, RefreshCw, FileText, Clock, Zap, Loader2, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { format, formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import type { Invoice } from "@/hooks/useInvoices";
import { invokeWithAdminKey } from "@/lib/adminApi";

interface PendingInvoicesTableProps {
  invoices: Invoice[];
  isLoading: boolean;
  onSync: () => void;
  isSyncing: boolean;
}

interface ChargeAllResult {
  succeeded: number;
  failed: number;
  totalRecovered: number;
}

export function PendingInvoicesTable({
  invoices,
  isLoading,
  onSync,
  isSyncing,
}: PendingInvoicesTableProps) {
  const [chargingInvoice, setChargingInvoice] = useState<string | null>(null);
  const [isChargingAll, setIsChargingAll] = useState(false);
  const [chargeProgress, setChargeProgress] = useState(0);
  const [chargeResult, setChargeResult] = useState<ChargeAllResult | null>(null);
  const { toast } = useToast();

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="outline" className="border-zinc-700 text-zinc-400 bg-zinc-800">Borrador</Badge>;
      case "open":
        return <Badge variant="outline" className="border-amber-500/50 text-amber-400 bg-amber-500/10">Abierta</Badge>;
      default:
        return <Badge variant="outline" className="border-zinc-700 text-white bg-zinc-800">{status}</Badge>;
    }
  };

  const formatScheduledDate = (dateStr: string | null) => {
    if (!dateStr) return "Sin programar";
    const date = new Date(dateStr);
    const relative = formatDistanceToNow(date, { addSuffix: true, locale: es });
    const absolute = format(date, "dd MMM, HH:mm", { locale: es });
    return (
      <div className="flex flex-col">
        <span className="text-white">{relative}</span>
        <span className="text-xs text-muted-foreground">{absolute}</span>
      </div>
    );
  };

  const handleForceCharge = async (invoice: Invoice) => {
    setChargingInvoice(invoice.id);
    try {
      const data = await invokeWithAdminKey<{ success?: boolean; amount_paid?: number; message?: string }>("force-charge-invoice", { stripe_invoice_id: invoice.stripe_invoice_id });

      if (data?.success) {
        toast({
          title: "¡Cobro exitoso!",
          description: `Factura cobrada: $${((data.amount_paid ?? 0) / 100).toFixed(2)}`,
        });
        onSync();
      } else {
        toast({
          title: "No se pudo cobrar",
          description: data?.message || "La factura no está en estado válido para cobrar.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error charging invoice:", error);
      const errMsg = error instanceof Error ? error.message : "Error desconocido";
      toast({
        title: "Error al cobrar",
        description: errMsg,
        variant: "destructive",
      });
    } finally {
      setChargingInvoice(null);
    }
  };

  const handleChargeAll = async () => {
    if (invoices.length === 0) return;

    setIsChargingAll(true);
    setChargeProgress(0);
    setChargeResult(null);

    const result: ChargeAllResult = {
      succeeded: 0,
      failed: 0,
      totalRecovered: 0,
    };

    const chargeableInvoices = invoices.filter(
      (inv) => inv.status === "draft" || inv.status === "open"
    );

    for (let i = 0; i < chargeableInvoices.length; i++) {
      const invoice = chargeableInvoices[i];
      
      try {
        const data = await invokeWithAdminKey<{ success?: boolean; amount_paid?: number }>("force-charge-invoice", { stripe_invoice_id: invoice.stripe_invoice_id });

        if (data?.success) {
          result.succeeded++;
          result.totalRecovered += data.amount_paid ?? 0;
        } else {
          result.failed++;
        }
      } catch {
        result.failed++;
      }

      // Update progress
      setChargeProgress(Math.round(((i + 1) / chargeableInvoices.length) * 100));
      
      // Small delay to avoid rate limiting
      if (i < chargeableInvoices.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    setChargeResult(result);
    setIsChargingAll(false);

    toast({
      title: "Cobro masivo completado",
      description: `✅ ${result.succeeded} cobradas ($${(result.totalRecovered / 100).toFixed(2)}) | ❌ ${result.failed} fallidas`,
    });

    // Sync to refresh the list and remove charged invoices
    onSync();
  };

  const clearResult = () => setChargeResult(null);

  return (
    <TooltipProvider>
      <div className="rounded-xl border border-zinc-800 bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Cobros Pendientes</h2>
              <p className="text-sm text-muted-foreground">
                Facturas esperando cobro automático de Stripe
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Charge All Button */}
            {invoices.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleChargeAll}
                    disabled={isChargingAll || isSyncing}
                    className="gap-2 bg-primary hover:bg-primary/90 text-white"
                  >
                    {isChargingAll ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlayCircle className="h-4 w-4" />
                    )}
                    Cobrar Todas
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Intenta cobrar todas las {invoices.length} facturas pendientes
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={onSync}
              disabled={isSyncing || isChargingAll}
              className="gap-2 border-zinc-700 text-white hover:bg-zinc-800"
            >
              <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
              Sincronizar
            </Button>
          </div>
        </div>

        {/* Charging All Progress */}
        {isChargingAll && (
          <div className="mb-4 p-4 rounded-lg bg-primary/10 border border-primary/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-primary font-medium">
                Cobrando facturas...
              </span>
              <span className="text-sm text-white">{chargeProgress}%</span>
            </div>
            <Progress value={chargeProgress} className="h-2" />
          </div>
        )}

        {/* Charge Result Summary */}
        {chargeResult && !isChargingAll && (
          <div className="mb-4 p-4 rounded-lg bg-zinc-800/50 border border-zinc-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-emerald-400">{chargeResult.succeeded}</p>
                  <p className="text-xs text-muted-foreground">Cobradas</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-white">
                    ${(chargeResult.totalRecovered / 100).toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">Recuperado</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-red-400">{chargeResult.failed}</p>
                  <p className="text-xs text-muted-foreground">Fallidas</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearResult}
                className="text-muted-foreground"
              >
                Cerrar
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-800/50" />
            ))}
          </div>
        ) : invoices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Clock className="h-12 w-12 text-zinc-600 mb-3" />
            <p className="text-muted-foreground">No hay facturas pendientes</p>
            <p className="text-sm text-muted-foreground/70">
              Las facturas en draft/open aparecerán aquí
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-zinc-800">
                <TableHead className="text-muted-foreground">Cliente</TableHead>
                <TableHead className="text-muted-foreground">Monto</TableHead>
                <TableHead className="text-muted-foreground">Estado</TableHead>
                <TableHead className="text-muted-foreground">Cobro Programado</TableHead>
                <TableHead className="text-muted-foreground text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow 
                  key={invoice.id} 
                  className="hover:bg-muted/20 border-zinc-800"
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-white">
                        {invoice.customer_email || "Sin email"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {invoice.stripe_invoice_id.slice(0, 20)}...
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-lg font-semibold text-white">
                      ${(invoice.amount_due / 100).toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground ml-1">
                      {invoice.currency?.toUpperCase()}
                    </span>
                  </TableCell>
                  <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                  <TableCell>
                    {formatScheduledDate(invoice.next_payment_attempt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* Force Charge Button - Only for draft/open */}
                      {(invoice.status === "draft" || invoice.status === "open") && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="default"
                              size="sm"
                              className="gap-2 bg-primary hover:bg-primary/90 text-white"
                              onClick={() => handleForceCharge(invoice)}
                              disabled={chargingInvoice === invoice.id || isChargingAll}
                            >
                              {chargingInvoice === invoice.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Zap className="h-4 w-4" />
                              )}
                              Cobrar Ya
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {invoice.status === "draft" 
                              ? "Finaliza y cobra esta factura inmediatamente" 
                              : "Intenta cobrar esta factura ahora"}
                          </TooltipContent>
                        </Tooltip>
                      )}

                      {/* View in Stripe Button */}
                      {invoice.hosted_invoice_url ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          asChild
                          className="gap-2 text-white hover:text-primary hover:bg-zinc-800"
                        >
                          <a
                            href={invoice.hosted_invoice_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-4 w-4" />
                            Ver
                          </a>
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Sin link
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {invoices.length > 0 && (
          <div className="mt-4 pt-4 border-t border-amber-500/10 flex justify-between items-center">
            <span className="text-sm text-muted-foreground">
              {invoices.length} {invoices.length === 1 ? "factura" : "facturas"} pendientes
            </span>
            <span className="text-lg font-bold text-amber-300">
              Total: ${(invoices.reduce((sum, inv) => sum + inv.amount_due, 0) / 100).toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
