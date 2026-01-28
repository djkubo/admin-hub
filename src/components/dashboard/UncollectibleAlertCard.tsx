import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface UncollectibleAlertCardProps {
  totalAmount: number;
  invoiceCount: number;
  isLoading?: boolean;
}

export function UncollectibleAlertCard({ 
  totalAmount, 
  invoiceCount,
  isLoading 
}: UncollectibleAlertCardProps) {
  if (totalAmount === 0) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="rounded-xl border border-red-500/30 bg-gradient-to-br from-red-500/10 via-rose-500/5 to-orange-500/10 p-4 shadow-lg shadow-red-500/5 hover:shadow-red-500/10 transition-all duration-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/20 ring-2 ring-red-500/30">
                  <AlertTriangle className="h-5 w-5 text-red-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-red-300/80">
                    Incobrables
                  </p>
                  <div className="flex items-baseline gap-2">
                    {isLoading ? (
                      <div className="h-6 w-20 animate-pulse rounded bg-red-500/20" />
                    ) : (
                      <>
                        <p className="text-xl font-bold text-red-100">
                          ${totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </p>
                        <span className="text-xs text-red-400/60">USD</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="text-right">
                <span className="text-xs text-red-400/70">{invoiceCount} facturas</span>
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs bg-[#1a1f36] border-red-500/30">
          <div className="space-y-2 p-1">
            <p className="font-medium text-red-300">⚠️ Ingresos Perdidos</p>
            <p className="text-sm text-muted-foreground">
              Facturas marcadas como <span className="text-red-400">uncollectible</span> en Stripe. 
              El método de pago del cliente falló múltiples veces.
            </p>
            <p className="text-xs text-red-500/70">
              Considera contactar a estos clientes para recuperar el pago.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
