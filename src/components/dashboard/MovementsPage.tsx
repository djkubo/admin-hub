import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format, startOfMonth, endOfMonth, subMonths, startOfDay, endOfDay, subDays } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  TrendingDown,
  Ban,
  Copy,
  Check,
  Download,
  CalendarIcon,
  AlertTriangle,
  Loader2
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { DateRange } from "react-day-picker";

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
    gross_amount?: number;
    paypal_payer_id?: string;
    event_description?: string;
    evidence_due_by?: string;
    dispute_reason?: string;
    [key: string]: any;
  } | null;
}

interface Dispute {
  id: string;
  external_dispute_id: string;
  amount: number;
  currency: string | null;
  status: string;
  reason: string | null;
  customer_email: string | null;
  created_at_external: string | null;
  source: string;
  evidence_due_by: string | null;
}

const formatAmount = (amount: number, currency: string | null, isNegative = false) => {
  const curr = currency?.toUpperCase() || "USD";
  const value = isNegative ? -Math.abs(amount / 100) : amount / 100;
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: curr,
    minimumFractionDigits: 2,
  }).format(value);
};

const getStatusConfig = (status: string) => {
  const configs: Record<string, { label: string; icon: typeof CheckCircle2; className: string; isNegative?: boolean }> = {
    succeeded: { label: "Exitoso", icon: CheckCircle2, className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
    paid: { label: "Completado", icon: CheckCircle2, className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
    failed: { label: "Erróneo", icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/20" },
    requires_payment_method: { label: "Bloqueado", icon: Ban, className: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
    requires_action: { label: "En trámite", icon: Clock, className: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
    canceled: { label: "Cancelado", icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/20" },
    refunded: { label: "Reembolsado", icon: TrendingDown, className: "bg-purple-500/10 text-purple-500 border-purple-500/20", isNegative: true },
    pending: { label: "Pendiente", icon: Clock, className: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
    needs_response: { label: "⚠️ Disputa", icon: AlertTriangle, className: "bg-orange-500/10 text-orange-500 border-orange-500/20", isNegative: true },
    under_review: { label: "⚠️ En revisión", icon: AlertTriangle, className: "bg-orange-500/10 text-orange-500 border-orange-500/20", isNegative: true },
    won: { label: "Disputa ganada", icon: CheckCircle2, className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
    lost: { label: "⚠️ Disputa perdida", icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/20", isNegative: true },
  };
  return configs[status] || { label: status, icon: AlertCircle, className: "bg-muted text-muted-foreground" };
};

const getSourceConfig = (source: string | null) => {
  const configs: Record<string, { label: string; icon: typeof CreditCard; className: string }> = {
    stripe: { label: "Stripe", icon: CreditCard, className: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" },
    paypal: { label: "PayPal", icon: Wallet, className: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
    web: { label: "Web", icon: Globe, className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
    dispute: { label: "Disputa", icon: AlertTriangle, className: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  };
  return configs[source || 'stripe'] || configs.stripe;
};

const getDescription = (m: Movement): string => {
  if (m.metadata?.invoice_number) return `Invoice ${m.metadata.invoice_number}`;
  if (m.metadata?.event_description) return m.metadata.event_description;
  if (m.metadata?.product_name) return m.metadata.product_name;
  if (m.metadata?.dispute_reason) return `Disputa: ${m.metadata.dispute_reason}`;
  return "—";
};

const getDeclineReason = (m: Movement): string | null => {
  if (m.metadata?.decline_reason_es) return m.metadata.decline_reason_es;
  const failureMap: Record<string, string> = {
    'insufficient_funds': 'Fondos insuficientes',
    'card_declined': 'Tarjeta rechazada',
    'generic_decline': 'Rechazo genérico',
    'expired_card': 'Tarjeta expirada',
    'incorrect_cvc': 'CVC incorrecto',
  };
  if (m.failure_message && failureMap[m.failure_message]) return failureMap[m.failure_message];
  if (m.failure_code && failureMap[m.failure_code]) return failureMap[m.failure_code];
  return m.failure_message || m.failure_code || null;
};

const getPaymentMethod = (m: Movement): { display: string; brand?: string } => {
  if (m.source === 'paypal') return { display: 'PayPal', brand: 'paypal' };
  if (m.source === 'dispute') return { display: 'Disputa', brand: 'dispute' };
  if (m.metadata?.card_last4) {
    return { display: `•••• ${m.metadata.card_last4}`, brand: m.metadata.card_brand?.toLowerCase() || '' };
  }
  return { display: '—' };
};

const getCardBrandStyle = (brand?: string) => {
  const styles: Record<string, string> = {
    visa: 'text-blue-500',
    mastercard: 'text-orange-500',
    amex: 'text-blue-400',
    paypal: 'text-blue-500',
    dispute: 'text-orange-500',
  };
  return styles[brand || ''] || 'text-muted-foreground';
};

// Date presets
const DATE_PRESETS = [
  { label: "Este Mes", getValue: () => ({ from: startOfMonth(new Date()), to: endOfDay(new Date()) }) },
  { label: "Mes Pasado", getValue: () => ({ from: startOfMonth(subMonths(new Date(), 1)), to: endOfMonth(subMonths(new Date(), 1)) }) },
  { label: "Últimos 7 días", getValue: () => ({ from: subDays(new Date(), 7), to: new Date() }) },
  { label: "Últimos 30 días", getValue: () => ({ from: subDays(new Date(), 30), to: new Date() }) },
  { label: "Últimos 90 días", getValue: () => ({ from: subDays(new Date(), 90), to: new Date() }) },
  { label: "Todo", getValue: () => undefined },
];

export function MovementsPage() {
  const { toast } = useToast();
  const [movements, setMovements] = useState<Movement[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: startOfMonth(new Date()),
    to: endOfDay(new Date())
  }));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 500);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Server-side fetch with all filters
  const fetchMovements = useCallback(async () => {
    setIsLoading(true);
    try {
      let txQuery = supabase
        .from("transactions")
        .select("*", { count: "exact" })
        .order("stripe_created_at", { ascending: false });

      if (dateRange?.from) txQuery = txQuery.gte("stripe_created_at", startOfDay(dateRange.from).toISOString());
      if (dateRange?.to) txQuery = txQuery.lte("stripe_created_at", endOfDay(dateRange.to).toISOString());
      if (sourceFilter !== "all" && sourceFilter !== "dispute") txQuery = txQuery.eq("source", sourceFilter);
      
      if (statusFilter !== "all") {
        if (statusFilter === "success") txQuery = txQuery.in("status", ["succeeded", "paid"]);
        else if (statusFilter === "failed") txQuery = txQuery.in("status", ["failed", "requires_payment_method", "canceled"]);
        else if (statusFilter === "refunded") txQuery = txQuery.eq("status", "refunded");
        else if (statusFilter === "pending") txQuery = txQuery.in("status", ["pending", "requires_action"]);
      }

      if (debouncedSearch) {
        txQuery = txQuery.or(`customer_email.ilike.%${debouncedSearch}%,stripe_payment_intent_id.ilike.%${debouncedSearch}%,external_transaction_id.ilike.%${debouncedSearch}%`);
      }

      txQuery = txQuery.limit(500);
      const { data: txData, error: txError, count } = await txQuery;
      if (txError) throw txError;
      
      setMovements(txData as Movement[]);
      setTotalCount(count || 0);

      // Fetch disputes
      if (sourceFilter === "all" || sourceFilter === "dispute") {
        let disputeQuery = supabase.from("disputes").select("*").order("created_at_external", { ascending: false });
        if (dateRange?.from) disputeQuery = disputeQuery.gte("created_at_external", startOfDay(dateRange.from).toISOString());
        if (dateRange?.to) disputeQuery = disputeQuery.lte("created_at_external", endOfDay(dateRange.to).toISOString());
        const { data: disputeData } = await disputeQuery;
        setDisputes(disputeData || []);
      } else {
        setDisputes([]);
      }
    } catch (error) {
      console.error("Error fetching movements:", error);
      toast({ title: "Error", description: "No se pudieron cargar los movimientos", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [dateRange, sourceFilter, statusFilter, debouncedSearch, toast]);

  useEffect(() => { fetchMovements(); }, [fetchMovements]);

  useEffect(() => {
    const channel = supabase
      .channel('movements-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, () => fetchMovements())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchMovements]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchMovements();
    setIsRefreshing(false);
  };

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      const response = await invokeWithAdminKey("export-transactions-csv", {
        startDate: dateRange?.from?.toISOString(),
        endDate: dateRange?.to?.toISOString(),
        source: sourceFilter !== "all" ? sourceFilter : undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        search: debouncedSearch || undefined,
        includeDisputes: true
      });

      if (typeof response === 'string' || response instanceof Blob) {
        const blob = typeof response === 'string' ? new Blob([response], { type: 'text/csv;charset=utf-8;' }) : response;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `movimientos_${dateRange?.from?.toISOString().split('T')[0] || 'all'}_${dateRange?.to?.toISOString().split('T')[0] || 'today'}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast({ title: "Exportación completada", description: `CSV descargado exitosamente` });
      } else {
        throw new Error("Formato inesperado");
      }
    } catch (error) {
      console.error("Export error:", error);
      toast({ title: "Error de exportación", description: "No se pudo generar el CSV", variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  // Combined data
  const allMovements = useMemo(() => {
    const disputeMovements: Movement[] = disputes.map(d => ({
      id: d.id,
      stripe_payment_intent_id: d.external_dispute_id,
      payment_key: null,
      payment_type: "dispute",
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      failure_code: null,
      failure_message: d.reason,
      customer_email: d.customer_email,
      stripe_created_at: d.created_at_external,
      source: "dispute",
      external_transaction_id: d.external_dispute_id,
      subscription_id: null,
      metadata: { evidence_due_by: d.evidence_due_by, dispute_reason: d.reason }
    }));

    const combined = [...movements, ...disputeMovements];
    combined.sort((a, b) => {
      const dateA = a.stripe_created_at ? new Date(a.stripe_created_at).getTime() : 0;
      const dateB = b.stripe_created_at ? new Date(b.stripe_created_at).getTime() : 0;
      return dateB - dateA;
    });
    return combined;
  }, [movements, disputes]);

  // Stats
  const stats = useMemo(() => {
    const successMovements = movements.filter(m => ['succeeded', 'paid'].includes(m.status));
    const failedMovements = movements.filter(m => ['failed', 'requires_payment_method', 'canceled'].includes(m.status));
    const refundedMovements = movements.filter(m => m.status === 'refunded');
    
    const totalSuccess = successMovements.reduce((sum, m) => sum + m.amount, 0);
    const totalFailed = failedMovements.reduce((sum, m) => sum + m.amount, 0);
    const totalRefunded = refundedMovements.reduce((sum, m) => sum + m.amount, 0);
    const totalDisputes = disputes.reduce((sum, d) => sum + d.amount, 0);
    const netRevenue = totalSuccess - totalRefunded - totalDisputes;

    return {
      totalCount,
      successCount: successMovements.length,
      failedCount: failedMovements.length,
      refundedCount: refundedMovements.length,
      disputeCount: disputes.length,
      totalSuccess,
      totalFailed,
      totalRefunded,
      totalDisputes,
      netRevenue,
      bySource: {
        stripe: movements.filter(m => m.source === 'stripe' || !m.source).length,
        paypal: movements.filter(m => m.source === 'paypal').length,
        web: movements.filter(m => m.source === 'web').length,
        dispute: disputes.length,
      },
    };
  }, [movements, disputes, totalCount]);

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
            Libro Mayor - Movimientos
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            {totalCount.toLocaleString()} transacciones totales en el rango seleccionado
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={isExporting} className="gap-2">
            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Exportar CSV
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            Actualizar
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
            <Activity className="h-4 w-4" />
            Total
          </div>
          <p className="text-2xl font-bold text-foreground">{allMovements.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-2 text-emerald-400 text-xs mb-2">
            <TrendingUp className="h-4 w-4" />
            Ingresos
          </div>
          <p className="text-xl font-bold text-emerald-400">{stats.successCount}</p>
          <p className="text-xs text-emerald-400/70">{formatAmount(stats.totalSuccess, 'usd')}</p>
        </div>
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-destructive text-xs mb-2">
            <XCircle className="h-4 w-4" />
            Fallidos
          </div>
          <p className="text-xl font-bold text-destructive">{stats.failedCount}</p>
          <p className="text-xs text-destructive/70">{formatAmount(stats.totalFailed, 'usd')}</p>
        </div>
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4">
          <div className="flex items-center gap-2 text-purple-400 text-xs mb-2">
            <TrendingDown className="h-4 w-4" />
            Reembolsos
          </div>
          <p className="text-xl font-bold text-purple-400">{stats.refundedCount}</p>
          <p className="text-xs text-purple-400/70">-{formatAmount(stats.totalRefunded, 'usd')}</p>
        </div>
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
          <div className="flex items-center gap-2 text-orange-400 text-xs mb-2">
            <AlertTriangle className="h-4 w-4" />
            Disputas
          </div>
          <p className="text-xl font-bold text-orange-400">{stats.disputeCount}</p>
          <p className="text-xs text-orange-400/70">-{formatAmount(stats.totalDisputes, 'usd')}</p>
        </div>
        <div className="col-span-2 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-primary text-xs mb-2">
            <CheckCircle2 className="h-4 w-4" />
            Revenue Neto
          </div>
          <p className="text-2xl font-bold text-primary">{formatAmount(stats.netRevenue, 'usd')}</p>
          <p className="text-xs text-muted-foreground">Ingresos - Reembolsos - Disputas</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3">
        {/* Date Range Picker */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="justify-start text-left font-normal min-w-[260px]">
              <CalendarIcon className="mr-2 h-4 w-4" />
              {dateRange?.from ? (
                dateRange.to ? (
                  <>
                    {format(dateRange.from, "d MMM", { locale: es })} - {format(dateRange.to, "d MMM yyyy", { locale: es })}
                  </>
                ) : (
                  format(dateRange.from, "d MMM yyyy", { locale: es })
                )
              ) : (
                <span>Seleccionar fechas</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <div className="p-3 border-b space-y-2">
              <p className="text-sm font-medium">Rangos rápidos</p>
              <div className="flex flex-wrap gap-2">
                {DATE_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    variant="outline"
                    size="sm"
                    onClick={() => setDateRange(preset.getValue())}
                    className="text-xs"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
            <Calendar
              initialFocus
              mode="range"
              defaultMonth={dateRange?.from}
              selected={dateRange}
              onSelect={setDateRange}
              numberOfMonths={2}
              locale={es}
            />
          </PopoverContent>
        </Popover>

        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por email, nombre o ID (búsqueda global)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Source Filter */}
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
            <SelectItem value="dispute">Disputas</SelectItem>
          </SelectContent>
        </Select>

        {/* Status Filter */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full md:w-44">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            <SelectItem value="success">✅ Exitosos</SelectItem>
            <SelectItem value="failed">❌ Fallidos</SelectItem>
            <SelectItem value="refunded">↩️ Reembolsos</SelectItem>
            <SelectItem value="pending">⏳ Pendientes</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      <div className="text-sm text-muted-foreground">
        Mostrando {allMovements.length} movimientos de {totalCount.toLocaleString()} en total
        {disputes.length > 0 && ` (incluye ${disputes.length} disputas)`}
      </div>

      {/* Movements Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Importe</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Método</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Descripción</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Cliente</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Fecha</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Fuente</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Estado</th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {allMovements.map((m) => {
                const statusConfig = getStatusConfig(m.status);
                const sourceConfig = getSourceConfig(m.source);
                const StatusIcon = statusConfig.icon;
                const paymentMethod = getPaymentMethod(m);
                const declineReason = getDeclineReason(m);
                const description = getDescription(m);
                const isNegative = statusConfig.isNegative || m.status === 'refunded' || m.source === 'dispute';
                
                return (
                  <tr key={m.id} className="transition-colors hover:bg-muted/20">
                    {/* Amount */}
                    <td className="px-3 py-3">
                      <div className="flex flex-col">
                        <span className={cn(
                          "font-semibold text-sm",
                          isNegative ? "text-destructive" : 
                          ['succeeded', 'paid'].includes(m.status) ? "text-emerald-400" : 
                          "text-foreground"
                        )}>
                          {isNegative ? '-' : ''}{formatAmount(m.amount, m.currency)}
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase">{m.currency || 'USD'}</span>
                      </div>
                    </td>
                    
                    {/* Payment Method */}
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        {m.source === 'paypal' ? (
                          <Wallet className="h-4 w-4 text-blue-500" />
                        ) : m.source === 'dispute' ? (
                          <AlertTriangle className="h-4 w-4 text-orange-500" />
                        ) : (
                          <CreditCard className={cn("h-4 w-4", getCardBrandStyle(paymentMethod.brand))} />
                        )}
                        <span className="text-sm font-medium text-foreground">{paymentMethod.display}</span>
                      </div>
                    </td>
                    
                    {/* Description */}
                    <td className="px-3 py-3">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-1.5 max-w-[140px] cursor-help">
                              <span className="text-sm text-foreground truncate">{description}</span>
                              {m.external_transaction_id && (
                                <button
                                  onClick={() => handleCopyId(m.external_transaction_id!)}
                                  className="p-0.5 hover:bg-muted rounded opacity-60 hover:opacity-100 transition-opacity"
                                >
                                  {copiedId === m.external_transaction_id ? (
                                    <Check className="h-3 w-3 text-emerald-500" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <div className="text-xs space-y-1">
                              <p className="font-semibold">{description}</p>
                              {m.external_transaction_id && <p className="font-mono text-muted-foreground">{m.external_transaction_id}</p>}
                              <p className="font-mono text-muted-foreground/70">{m.stripe_payment_intent_id}</p>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                    
                    {/* Customer */}
                    <td className="px-3 py-3">
                      <div className="max-w-[180px]">
                        {m.metadata?.customer_name && (
                          <span className="text-sm font-medium text-foreground truncate block">{m.metadata.customer_name}</span>
                        )}
                        {m.customer_email ? (
                          <span className={cn("text-xs truncate block", m.metadata?.customer_name ? "text-muted-foreground" : "text-foreground")}>
                            {m.customer_email}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">Sin email</span>
                        )}
                      </div>
                    </td>
                    
                    {/* Date */}
                    <td className="px-3 py-3">
                      {m.stripe_created_at ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex flex-col cursor-help">
                                <span className="text-sm text-foreground whitespace-nowrap">
                                  {format(new Date(m.stripe_created_at), "d MMM", { locale: es })}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {format(new Date(m.stripe_created_at), "HH:mm", { locale: es })}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{format(new Date(m.stripe_created_at), "PPpp", { locale: es })}</p>
                              <p className="text-muted-foreground">
                                {formatDistanceToNow(new Date(m.stripe_created_at), { addSuffix: true, locale: es })}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </td>
                    
                    {/* Source */}
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={cn("text-[10px] border", sourceConfig.className)}>
                        {sourceConfig.label}
                      </Badge>
                    </td>
                    
                    {/* Status */}
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={cn("text-[10px] border gap-1", statusConfig.className)}>
                        <StatusIcon className="h-3 w-3" />
                        {statusConfig.label}
                      </Badge>
                    </td>
                    
                    {/* Decline Reason / Detail */}
                    <td className="px-3 py-3">
                      {declineReason ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1.5 cursor-help max-w-[120px]">
                                <AlertCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                                <span className="text-xs text-destructive truncate">{declineReason}</span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="font-semibold text-destructive">{declineReason}</p>
                              {m.failure_code && <p className="text-xs font-mono">{m.failure_code}</p>}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : m.metadata?.evidence_due_by ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-xs text-orange-400">
                                ⏰ {format(new Date(m.metadata.evidence_due_by), "d MMM", { locale: es })}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Evidencia requerida antes de: {format(new Date(m.metadata.evidence_due_by), "PPpp", { locale: es })}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        
        {allMovements.length === 0 && (
          <div className="p-8 text-center">
            <Activity className="mx-auto h-12 w-12 text-muted-foreground/50" />
            <p className="mt-4 text-muted-foreground">No se encontraron movimientos</p>
          </div>
        )}
      </div>
    </div>
  );
}
