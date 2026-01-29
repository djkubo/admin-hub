import { DollarSign, Clock, TrendingUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface IncomingRevenueCardProps {
  totalNext72h: number;
  totalPending: number;
  invoiceCount: number;
  isLoading?: boolean;
}

export function IncomingRevenueCard({ 
  totalNext72h, 
  totalPending, 
  invoiceCount,
  isLoading 
}: IncomingRevenueCardProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-orange-500/10 p-6 shadow-lg shadow-amber-500/5 hover:shadow-amber-500/10 transition-all duration-300">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/20 ring-2 ring-amber-500/30">
                  <TrendingUp className="h-6 w-6 text-amber-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-amber-300/80">
                    Proyectado (Próx. 72h)
                  </p>
                  <div className="flex items-baseline gap-2">
                    {isLoading ? (
                      <div className="h-8 w-24 animate-pulse rounded bg-amber-500/20" />
                    ) : (
                      <>
                        <p className="text-2xl font-bold text-amber-100">
                          ${totalNext72h.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </p>
                        <span className="text-xs text-amber-400/60">USD</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="text-right">
                <div className="flex items-center gap-1 text-amber-400/70">
                  <Clock className="h-4 w-4" />
                  <span className="text-xs">{invoiceCount} facturas</span>
                </div>
                {totalPending > totalNext72h && (
                  <p className="text-xs text-amber-500/50 mt-1">
                    +${(totalPending - totalNext72h).toFixed(2)} después
                  </p>
                )}
              </div>
            </div>

            {/* Progress indicator */}
            <div className="mt-4">
              <div className="flex justify-between text-xs text-amber-400/60 mb-1">
                <span>Próximas 72h</span>
                <span>Total pendiente: ${totalPending.toFixed(2)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-amber-900/30 overflow-hidden">
                <div 
                  className="h-full rounded-full bg-gradient-to-r from-amber-400 to-yellow-300 transition-all duration-500"
                  style={{ 
                    width: totalPending > 0 
                      ? `${Math.min((totalNext72h / totalPending) * 100, 100)}%` 
                      : '0%' 
                  }}
                />
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs bg-card border-amber-500/30">
          <div className="space-y-2 p-1">
            <p className="font-medium text-amber-300">💰 Dinero en Camino</p>
            <p className="text-sm text-muted-foreground">
              Facturas en estado <span className="text-amber-400">draft</span> u <span className="text-amber-400">open</span> que Stripe cobrará automáticamente según tus reglas de facturación (3 días de gracia).
            </p>
            <p className="text-xs text-amber-500/70">
              Puedes cobrar manualmente desde la tabla de Cobros Pendientes.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
