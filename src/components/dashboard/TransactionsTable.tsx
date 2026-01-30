import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, DollarSign, Mail } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface Transaction {
  id: string;
  stripe_payment_intent_id: string;
  amount: number;
  currency: string | null;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  customer_email: string | null;
  stripe_created_at: string | null;
}

interface TransactionsTableProps {
  transactions: Transaction[];
  isLoading?: boolean;
}

const formatAmount = (amount: number, currency: string | null) => {
  const curr = currency?.toUpperCase() || "USD";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: curr,
  }).format(amount / 100);
};

const getStatusBadge = (status: string) => {
  const statusConfig: Record<string, { label: string; className: string }> = {
    requires_payment_method: { 
      label: "Requiere método", 
      className: "bg-amber-500/10 text-amber-400 border-amber-500/20" 
    },
    requires_confirmation: { 
      label: "Requiere confirmación", 
      className: "bg-zinc-800 text-white border-zinc-700" 
    },
    requires_action: { 
      label: "Requiere acción", 
      className: "bg-amber-500/10 text-amber-400 border-amber-500/20" 
    },
    canceled: { 
      label: "Cancelado", 
      className: "bg-red-500/10 text-red-400 border-red-500/20" 
    },
  };

  const config = statusConfig[status] || { 
    label: status, 
    className: "bg-muted text-muted-foreground" 
  };

  return (
    <Badge variant="outline" className={cn("text-xs font-medium border", config.className)}>
      {config.label}
    </Badge>
  );
};

export function TransactionsTable({ transactions, isLoading }: TransactionsTableProps) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-8 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Cargando transacciones...</p>
        </div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-8 text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-muted-foreground">No hay transacciones fallidas</p>
          <p className="text-sm text-muted-foreground/70">
            Usa el botón "Sync Data" para sincronizar desde Stripe
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Payment Intent
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Cliente
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Monto
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Estado
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Error
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Fecha
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {transactions.map((tx) => (
              <tr
                key={tx.id}
                className="transition-colors hover:bg-muted/20"
              >
                <td className="px-6 py-4">
                  <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                    {tx.stripe_payment_intent_id.slice(0, 20)}...
                  </code>
                </td>
                <td className="px-6 py-4">
                  {tx.customer_email ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Mail className="h-3.5 w-3.5" />
                      {tx.customer_email}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground/50">Sin email</span>
                  )}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    {formatAmount(tx.amount, tx.currency)}
                  </div>
                </td>
                <td className="px-6 py-4">
                  {getStatusBadge(tx.status)}
                </td>
                <td className="px-6 py-4">
                  {tx.failure_code ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-2 cursor-help">
                            <AlertCircle className="h-4 w-4 text-destructive" />
                            <span className="text-sm text-destructive font-mono">
                              {tx.failure_code}
                            </span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>{tx.failure_message || "Sin mensaje de error"}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="text-sm text-muted-foreground/50">—</span>
                  )}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {tx.stripe_created_at ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          {formatDistanceToNow(new Date(tx.stripe_created_at), {
                            addSuffix: true,
                            locale: es,
                          })}
                        </TooltipTrigger>
                        <TooltipContent>
                          {format(new Date(tx.stripe_created_at), "PPpp", { locale: es })}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
