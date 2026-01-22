import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { 
  Activity, 
  AlertCircle, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Search,
  RefreshCw,
  Wallet,
  CreditCard,
  Globe,
  Filter,
  TrendingUp,
  TrendingDown
} from "lucide-react";

interface Movement {
  id: string;
  stripe_payment_intent_id: string;
  payment_key: string | null;
  payment_type: string | null;
  amount: number;
  currency: string | null;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  customer_email: string | null;
  stripe_created_at: string | null;
  source: string | null;
  external_transaction_id: string | null;
  subscription_id: string | null;
  metadata: {
    card_last4?: string;
    card_brand?: string;
    customer_name?: string;
    product_name?: string;
    invoice_number?: string;
    decline_reason_es?: string;
    fee_amount?: number;
    net_amount?: number;
    paypal_payer_id?: string;
    [key: string]: any;
  } | null;
}

const formatAmount = (amount: number, currency: string | null) => {
  const curr = currency?.toUpperCase() || "USD";
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: curr,
  }).format(amount / 100);
};

const getStatusConfig = (status: string) => {
  const configs: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
    succeeded: { 
      label: "Exitoso", 
      icon: CheckCircle2,
      className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" 
    },
    paid: { 
      label: "Pagado", 
      icon: CheckCircle2,
      className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" 
    },
    failed: { 
      label: "Fallido", 
      icon: XCircle,
      className: "bg-destructive/10 text-destructive border-destructive/20" 
    },
    requires_payment_method: { 
      label: "Requiere método", 
      icon: AlertCircle,
      className: "bg-amber-500/10 text-amber-500 border-amber-500/20" 
    },
    requires_action: { 
      label: "Requiere acción", 
      icon: Clock,
      className: "bg-orange-500/10 text-orange-500 border-orange-500/20" 
    },
    canceled: { 
      label: "Cancelado", 
      icon: XCircle,
      className: "bg-destructive/10 text-destructive border-destructive/20" 
    },
    refunded: { 
      label: "Reembolsado", 
      icon: TrendingDown,
      className: "bg-purple-500/10 text-purple-500 border-purple-500/20" 
    },
    pending: { 
      label: "Pendiente", 
      icon: Clock,
      className: "bg-blue-500/10 text-blue-500 border-blue-500/20" 
    },
  };

  return configs[status] || { 
    label: status, 
    icon: AlertCircle,
    className: "bg-muted text-muted-foreground" 
  };
};

const getSourceConfig = (source: string | null) => {
  const configs: Record<string, { label: string; icon: typeof CreditCard; className: string }> = {
    stripe: { 
      label: "Stripe", 
      icon: CreditCard,
      className: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" 
    },
    paypal: { 
      label: "PayPal", 
      icon: Wallet,
      className: "bg-blue-500/10 text-blue-400 border-blue-500/20" 
    },
    web: { 
      label: "Web", 
      icon: Globe,
      className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
    },
  };

  return configs[source || 'stripe'] || configs.stripe;
};

const getPaymentTypeLabel = (type: string | null) => {
  const types: Record<string, string> = {
    new: "Nuevo",
    renewal: "Renovación",
    trial_conversion: "Trial → Paid",
  };
  return types[type || ''] || type || "—";
};

export function MovementsPage() {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchMovements = async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .order("stripe_created_at", { ascending: false })
      .limit(500);

    if (!error && data) {
      setMovements(data as Movement[]);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    fetchMovements();

    // Real-time subscription
    const channel = supabase
      .channel('movements-realtime')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'transactions' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setMovements(prev => [payload.new as Movement, ...prev.slice(0, 499)]);
          } else if (payload.eventType === 'UPDATE') {
            setMovements(prev => prev.map(m => 
              m.id === (payload.new as Movement).id ? payload.new as Movement : m
            ));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchMovements();
    setIsRefreshing(false);
  };

  // Filtered movements
  const filteredMovements = useMemo(() => {
    return movements.filter(m => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesEmail = m.customer_email?.toLowerCase().includes(query);
        const matchesId = m.stripe_payment_intent_id?.toLowerCase().includes(query);
        const matchesExtId = m.external_transaction_id?.toLowerCase().includes(query);
        if (!matchesEmail && !matchesId && !matchesExtId) return false;
      }
      
      // Source filter
      if (sourceFilter !== "all" && m.source !== sourceFilter) return false;
      
      // Status filter
      if (statusFilter !== "all") {
        if (statusFilter === "success" && !['succeeded', 'paid'].includes(m.status)) return false;
        if (statusFilter === "failed" && !['failed', 'requires_payment_method', 'canceled'].includes(m.status)) return false;
        if (statusFilter === "pending" && !['pending', 'requires_action'].includes(m.status)) return false;
      }
      
      return true;
    });
  }, [movements, searchQuery, sourceFilter, statusFilter]);

  // Stats
  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayMovements = movements.filter(m => {
      if (!m.stripe_created_at) return false;
      return new Date(m.stripe_created_at) >= today;
    });

    const successToday = todayMovements.filter(m => ['succeeded', 'paid'].includes(m.status));
    const failedToday = todayMovements.filter(m => ['failed', 'requires_payment_method', 'canceled'].includes(m.status));
    
    const totalSuccess = successToday.reduce((sum, m) => sum + m.amount, 0);
    const totalFailed = failedToday.reduce((sum, m) => sum + m.amount, 0);
    
    const bySource = {
      stripe: movements.filter(m => m.source === 'stripe' || !m.source).length,
      paypal: movements.filter(m => m.source === 'paypal').length,
      web: movements.filter(m => m.source === 'web').length,
    };

    return {
      todayCount: todayMovements.length,
      successCount: successToday.length,
      failedCount: failedToday.length,
      totalSuccess,
      totalFailed,
      bySource,
    };
  }, [movements]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-foreground flex items-center gap-3">
            <Activity className="h-7 w-7 md:h-8 md:w-8 text-primary" />
            Movimientos en Tiempo Real
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Centralización de todas las transacciones: Stripe, PayPal y Web
          </p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="gap-2"
        >
          <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          Actualizar
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
            <Activity className="h-4 w-4" />
            Hoy
          </div>
          <p className="text-2xl font-bold text-foreground">{stats.todayCount}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-2 text-emerald-400 text-xs mb-2">
            <TrendingUp className="h-4 w-4" />
            Exitosos
          </div>
          <p className="text-2xl font-bold text-emerald-400">{stats.successCount}</p>
          <p className="text-xs text-emerald-400/70">{formatAmount(stats.totalSuccess, 'usd')}</p>
        </div>
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-destructive text-xs mb-2">
            <XCircle className="h-4 w-4" />
            Fallidos
          </div>
          <p className="text-2xl font-bold text-destructive">{stats.failedCount}</p>
          <p className="text-xs text-destructive/70">{formatAmount(stats.totalFailed, 'usd')}</p>
        </div>
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
          <div className="flex items-center gap-2 text-indigo-400 text-xs mb-2">
            <CreditCard className="h-4 w-4" />
            Stripe
          </div>
          <p className="text-2xl font-bold text-indigo-400">{stats.bySource.stripe}</p>
        </div>
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
          <div className="flex items-center gap-2 text-blue-400 text-xs mb-2">
            <Wallet className="h-4 w-4" />
            PayPal
          </div>
          <p className="text-2xl font-bold text-blue-400">{stats.bySource.paypal}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por email o ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-full md:w-40">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Fuente" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            <SelectItem value="stripe">Stripe</SelectItem>
            <SelectItem value="paypal">PayPal</SelectItem>
            <SelectItem value="web">Web</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full md:w-40">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="success">Exitosos</SelectItem>
            <SelectItem value="failed">Fallidos</SelectItem>
            <SelectItem value="pending">Pendientes</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      <div className="text-sm text-muted-foreground">
        Mostrando {filteredMovements.length} de {movements.length} movimientos
      </div>

      {/* Movements Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Fuente
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Cliente
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Monto
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Tipo
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Error
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Fecha
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredMovements.map((m) => {
                const statusConfig = getStatusConfig(m.status);
                const sourceConfig = getSourceConfig(m.source);
                const StatusIcon = statusConfig.icon;
                const SourceIcon = sourceConfig.icon;
                
                return (
                  <tr key={m.id} className="transition-colors hover:bg-muted/20">
                    {/* Source */}
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={cn("text-xs border gap-1", sourceConfig.className)}>
                        <SourceIcon className="h-3 w-3" />
                        {sourceConfig.label}
                      </Badge>
                    </td>
                    
                    {/* Customer */}
                    <td className="px-4 py-3">
                      <div className="max-w-[200px]">
                        {/* Customer name from metadata or email */}
                        {m.metadata?.customer_name ? (
                          <span className="text-sm font-medium text-foreground truncate block">
                            {m.metadata.customer_name}
                          </span>
                        ) : null}
                        {m.customer_email ? (
                          <span className={cn(
                            "text-sm truncate block",
                            m.metadata?.customer_name ? "text-muted-foreground" : "text-foreground"
                          )}>
                            {m.customer_email}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground/50">Sin email</span>
                        )}
                        {/* Card info for Stripe */}
                        {m.metadata?.card_last4 && (
                          <span className="text-[10px] text-muted-foreground">
                            •••• {m.metadata.card_last4} {m.metadata.card_brand && `(${m.metadata.card_brand})`}
                          </span>
                        )}
                        {/* Transaction ID */}
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <code className="text-[10px] text-muted-foreground/60 block truncate cursor-help">
                                {m.metadata?.invoice_number || m.external_transaction_id || m.stripe_payment_intent_id?.slice(0, 16)}
                              </code>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs space-y-1">
                                <p className="font-mono">{m.external_transaction_id || m.stripe_payment_intent_id}</p>
                                {m.metadata?.product_name && (
                                  <p className="text-muted-foreground">{m.metadata.product_name}</p>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </td>
                    
                    {/* Amount */}
                    <td className="px-4 py-3">
                      <span className={cn(
                        "font-semibold",
                        ['succeeded', 'paid'].includes(m.status) ? "text-emerald-400" : "text-foreground"
                      )}>
                        {formatAmount(m.amount, m.currency)}
                      </span>
                      <span className="text-xs text-muted-foreground ml-1">
                        {m.currency?.toUpperCase()}
                      </span>
                    </td>
                    
                    {/* Type */}
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {getPaymentTypeLabel(m.payment_type)}
                      </span>
                    </td>
                    
                    {/* Status */}
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={cn("text-xs border gap-1", statusConfig.className)}>
                        <StatusIcon className="h-3 w-3" />
                        {statusConfig.label}
                      </Badge>
                    </td>
                    
                    {/* Error / Product */}
                    <td className="px-4 py-3">
                      {m.failure_code ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1.5 cursor-help">
                                <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                                <span className="text-xs text-destructive truncate max-w-[120px]">
                                  {m.metadata?.decline_reason_es || m.failure_message || m.failure_code}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="font-semibold">{m.failure_code}</p>
                              <p>{m.failure_message || "Sin detalles"}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : m.metadata?.product_name ? (
                        <span className="text-xs text-muted-foreground truncate block max-w-[120px]">
                          {m.metadata.product_name}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground/50">—</span>
                      )}
                    </td>
                    
                    {/* Date */}
                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                      {m.stripe_created_at ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger>
                              {formatDistanceToNow(new Date(m.stripe_created_at), {
                                addSuffix: true,
                                locale: es,
                              })}
                            </TooltipTrigger>
                            <TooltipContent>
                              {format(new Date(m.stripe_created_at), "PPpp", { locale: es })}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        
        {filteredMovements.length === 0 && (
          <div className="p-8 text-center">
            <Activity className="mx-auto h-12 w-12 text-muted-foreground/50" />
            <p className="mt-4 text-muted-foreground">No se encontraron movimientos</p>
          </div>
        )}
      </div>
    </div>
  );
}
