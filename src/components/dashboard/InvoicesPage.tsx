import { useState, useMemo } from 'react';
import { FileText, DollarSign, Clock, ExternalLink, Loader2, CheckCircle, Calendar, Download, User, Package, RefreshCw, Search, FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInvoices, Invoice, InvoiceStatus } from '@/hooks/useInvoices';
import { toast } from 'sonner';
import { formatDistanceToNow, format, subDays } from 'date-fns';
import { es } from 'date-fns/locale';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { IncomingRevenueCard } from './IncomingRevenueCard';
import { UncollectibleAlertCard } from './UncollectibleAlertCard';

type DateRange = 'all' | '7d' | '30d' | '90d' | '365d';

export function InvoicesPage() {
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>('90d');
  const [chargingInvoice, setChargingInvoice] = useState<string | null>(null);
  const [isChargingAll, setIsChargingAll] = useState(false);
  const [chargeProgress, setChargeProgress] = useState<{ current: number; total: number; recovered: number } | null>(null);

  // Calculate date range
  const dateRangeValues = useMemo(() => {
    if (dateRange === 'all') return { startDate: undefined, endDate: undefined };
    const days = parseInt(dateRange);
    return {
      startDate: subDays(new Date(), days).toISOString(),
      endDate: new Date().toISOString(),
    };
  }, [dateRange]);

  const { 
    invoices, 
    isLoading, 
    syncInvoices, 
    syncInvoicesFull,
    syncProgress,
    totalPending, 
    totalPaid,
    totalNext72h,
    invoicesNext72h,
    totalUncollectible,
    uncollectibleCount,
    statusCounts,
    exportToCSV,
    refetch 
  } = useInvoices({
    statusFilter,
    searchQuery,
    startDate: dateRangeValues.startDate,
    endDate: dateRangeValues.endDate,
  });

  // Sort invoices
  const sortedInvoices = useMemo(() => {
    return [...invoices].sort((a, b) => {
      // Sort by stripe_created_at descending (newest first)
      const dateA = a.stripe_created_at ? new Date(a.stripe_created_at).getTime() : 0;
      const dateB = b.stripe_created_at ? new Date(b.stripe_created_at).getTime() : 0;
      return dateB - dateA;
    });
  }, [invoices]);

  const handleChargeInvoice = async (invoice: Invoice) => {
    setChargingInvoice(invoice.id);
    try {
      const data = await invokeWithAdminKey<{ success?: boolean; error?: string }>('force-charge-invoice', { invoice_id: invoice.stripe_invoice_id });

      if (data?.success) {
        toast.success(`Cobro exitoso: $${(invoice.amount_due / 100).toFixed(2)}`);
        refetch();
      } else {
        toast.error(data?.error || 'Error al cobrar');
      }
    } catch (error) {
      console.error('Error charging invoice:', error);
      toast.error('Error al procesar el cobro');
    } finally {
      setChargingInvoice(null);
    }
  };

  const handleChargeAll = async () => {
    const toCharge = sortedInvoices.filter((i: Invoice) => i.status === 'open');

    if (toCharge.length === 0) {
      toast.error('No hay facturas elegibles para cobrar');
      return;
    }

    setIsChargingAll(true);
    setChargeProgress({ current: 0, total: toCharge.length, recovered: 0 });

    let recovered = 0;
    let failed = 0;

    for (let i = 0; i < toCharge.length; i++) {
      const invoice = toCharge[i];
      setChargeProgress({ current: i + 1, total: toCharge.length, recovered });

      try {
        const data = await invokeWithAdminKey('force-charge-invoice', { invoice_id: invoice.stripe_invoice_id });

        if (data?.success) {
          recovered += invoice.amount_due;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    setIsChargingAll(false);
    setChargeProgress(null);
    refetch();

    toast.success(`Cobro masivo completado: $${(recovered / 100).toFixed(2)} recuperados, ${failed} fallidos`);
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      draft: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
      open: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
      paid: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
      void: 'bg-red-500/10 text-red-400 border-red-500/30',
      uncollectible: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    };
    const labels: Record<string, string> = {
      draft: 'Borrador',
      open: 'Abierta',
      paid: 'Pagada',
      void: 'Anulada',
      uncollectible: 'Incobrable',
    };
    return (
      <Badge variant="outline" className={styles[status] || styles.open}>
        {labels[status] || status}
      </Badge>
    );
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2 md:gap-3">
            <FileText className="h-6 w-6 md:h-8 md:w-8 text-blue-500" />
            Facturas
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            Mirror completo de Stripe Invoices
          </p>
        </div>
        <div className="flex items-center gap-3 justify-between sm:justify-end">
          <div className="text-left sm:text-right">
            <p className="text-xl md:text-2xl font-bold text-foreground">${totalPending.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-xs text-muted-foreground">Pendiente</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xl md:text-2xl font-bold text-emerald-400">${totalPaid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-xs text-muted-foreground">Cobrado</p>
          </div>
        </div>
      </div>

      {/* Revenue Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <IncomingRevenueCard
          totalNext72h={totalNext72h}
          totalPending={totalPending}
          invoiceCount={invoicesNext72h.length}
          isLoading={isLoading}
        />
        <UncollectibleAlertCard
          totalAmount={totalUncollectible}
          invoiceCount={uncollectibleCount}
          isLoading={isLoading}
        />
      </div>

      {syncProgress && (
        <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs md:text-sm font-medium">Sincronizando facturas...</span>
            <span className="text-xs text-muted-foreground">{syncProgress.current} procesadas</span>
          </div>
          <Progress value={syncProgress.hasMore ? 50 : 100} className="h-2" />
        </div>
      )}

      {/* Charge Progress */}
      {chargeProgress && (
        <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs md:text-sm font-medium">Cobrando facturas...</span>
            <span className="text-xs text-muted-foreground">{chargeProgress.current}/{chargeProgress.total}</span>
          </div>
          <Progress value={(chargeProgress.current / chargeProgress.total) * 100} className="h-2" />
          <p className="text-xs text-emerald-400 mt-2">Recuperado: ${(chargeProgress.recovered / 100).toFixed(2)}</p>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
        <div className="flex flex-col gap-3">
          {/* Status Tabs */}
          <div className="overflow-x-auto -mx-3 px-3">
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as InvoiceStatus)}>
              <TabsList className="bg-muted/50 h-8 min-w-max">
                <TabsTrigger value="all" className="text-xs px-2 md:px-3">Todas ({statusCounts.all})</TabsTrigger>
                <TabsTrigger value="open" className="text-xs px-2 md:px-3">Abiertas ({statusCounts.open})</TabsTrigger>
                <TabsTrigger value="paid" className="text-xs px-2 md:px-3">Pagadas ({statusCounts.paid})</TabsTrigger>
                <TabsTrigger value="draft" className="text-xs px-2 md:px-3">Borrador ({statusCounts.draft})</TabsTrigger>
                <TabsTrigger value="void" className="text-xs px-2 md:px-3">Anuladas ({statusCounts.void})</TabsTrigger>
                <TabsTrigger value="uncollectible" className="text-xs px-2 md:px-3">Incobrables ({statusCounts.uncollectible})</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Search, Date filter and actions */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
              <div className="relative flex-1 sm:flex-none">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar email, nombre, factura..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 w-full sm:w-64 bg-muted/50 border-border/50 text-sm"
                />
              </div>
              <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
                <SelectTrigger className="w-28 bg-muted/50 border-border/50 text-xs h-8">
                  <Calendar className="h-3.5 w-3.5 mr-1.5" />
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  <SelectItem value="7d">7 días</SelectItem>
                  <SelectItem value="30d">30 días</SelectItem>
                  <SelectItem value="90d">90 días</SelectItem>
                  <SelectItem value="365d">1 año</SelectItem>
                  <SelectItem value="all">Todo</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <Button
                onClick={() => exportToCSV()}
                variant="outline"
                size="sm"
                className="h-8 text-xs"
              >
                <FileDown className="h-3.5 w-3.5 mr-1.5" />
                CSV
              </Button>
              <Button
                onClick={() => syncInvoices.mutate()}
                disabled={syncInvoices.isPending || !!syncProgress}
                variant="outline"
                size="sm"
                className="h-8 text-xs"
              >
                {syncInvoices.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span className="ml-1.5">Sync</span>
              </Button>
              <Button
                onClick={() => syncInvoicesFull('full')}
                disabled={syncInvoices.isPending || !!syncProgress}
                variant="outline"
                size="sm"
                className="h-8 text-xs"
              >
                {syncProgress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span className="ml-1">Full</span>
              </Button>
              {statusFilter === 'open' && (
                <Button
                  onClick={handleChargeAll}
                  disabled={isChargingAll || sortedInvoices.filter(i => i.status === 'open').length === 0}
                  size="sm"
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-xs h-8"
                >
                  {isChargingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DollarSign className="h-3.5 w-3.5" />}
                  Cobrar todas
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="rounded-xl border border-border/50 bg-card p-8 md:p-12 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
          <p className="text-sm text-muted-foreground">Cargando facturas...</p>
        </div>
      ) : sortedInvoices.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card p-8 md:p-12 text-center">
          <CheckCircle className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-3 text-emerald-500/50" />
          <p className="text-sm text-muted-foreground mb-1">Sin facturas en este filtro</p>
          <p className="text-xs text-muted-foreground/60">Prueba con otro filtro o sincroniza desde Stripe</p>
        </div>
      ) : (
        <>
          {/* Mobile Cards */}
          <div className="md:hidden space-y-3">
            {sortedInvoices.slice(0, 50).map((invoice) => (
              <div key={invoice.id} className="rounded-xl border border-border/50 bg-card p-4 touch-feedback">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <p className="font-medium text-foreground text-sm truncate">
                        {invoice.client?.full_name || invoice.customer_name || 'Sin nombre'}
                      </p>
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate ml-5">
                      {invoice.client?.email || invoice.customer_email || '—'}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-foreground ml-2">
                    ${((invoice.total ?? invoice.amount_due) / 100).toFixed(2)}
                  </span>
                </div>

                {(invoice.plan_name || invoice.product_name || invoice.plan_interval) && (
                  <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                    <Package className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">
                      {invoice.product_name || invoice.plan_name || 'Plan'}
                      {invoice.plan_interval && ` · ${invoice.plan_interval}`}
                    </span>
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground truncate mb-2">
                  {invoice.invoice_number || invoice.stripe_invoice_id}
                </p>
                
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {getStatusBadge(invoice.status)}
                  {invoice.plan_interval && (
                    <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-400 border-purple-500/30">
                      {invoice.plan_interval}
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground mb-3">
                  <div>
                    <span className="text-muted-foreground/60">Creada: </span>
                    {invoice.stripe_created_at ? format(new Date(invoice.stripe_created_at), 'dd MMM yy', { locale: es }) : '—'}
                  </div>
                  <div>
                    <span className="text-muted-foreground/60">Vence: </span>
                    {invoice.due_date ? format(new Date(invoice.due_date), 'dd MMM yy', { locale: es }) : '—'}
                  </div>
                </div>

                {invoice.last_finalization_error && (
                  <p className="text-[10px] text-red-400 mb-2 truncate">⚠️ {invoice.last_finalization_error}</p>
                )}

                <div className="flex items-center gap-2">
                  {invoice.status === 'open' && (
                    <Button
                      size="sm"
                      onClick={() => handleChargeInvoice(invoice)}
                      disabled={chargingInvoice === invoice.id}
                      className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-xs h-8 flex-1"
                    >
                      {chargingInvoice === invoice.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <DollarSign className="h-3.5 w-3.5" />
                      )}
                      Cobrar
                    </Button>
                  )}
                  {invoice.pdf_url && (
                    <Button size="sm" variant="outline" onClick={() => window.open(invoice.pdf_url!, '_blank')} className="h-8">
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {invoice.hosted_invoice_url && (
                    <Button size="sm" variant="outline" onClick={() => window.open(invoice.hosted_invoice_url!, '_blank')} className="h-8">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {sortedInvoices.length > 50 && (
              <p className="text-center text-xs text-muted-foreground py-4">
                Mostrando 50 de {sortedInvoices.length} facturas. Usa el buscador para filtrar.
              </p>
            )}
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block rounded-xl border border-border/50 bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50 hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Total</TableHead>
                    <TableHead className="text-muted-foreground">Estado</TableHead>
                    <TableHead className="text-muted-foreground">Factura</TableHead>
                    <TableHead className="text-muted-foreground">Cliente</TableHead>
                    <TableHead className="text-muted-foreground">Frecuencia</TableHead>
                    <TableHead className="text-muted-foreground">Creada</TableHead>
                    <TableHead className="text-muted-foreground">Vence</TableHead>
                    <TableHead className="text-muted-foreground">Finalización</TableHead>
                    <TableHead className="text-right text-muted-foreground">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedInvoices.slice(0, 100).map((invoice) => (
                    <TableRow key={invoice.id} className="border-border/50 hover:bg-muted/20">
                      <TableCell>
                        <span className="text-lg font-semibold text-foreground">
                          ${((invoice.total ?? invoice.amount_due) / 100).toFixed(2)}
                        </span>
                        <span className="text-xs text-muted-foreground uppercase ml-1">{invoice.currency}</span>
                      </TableCell>
                      <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-mono text-muted-foreground">
                            {invoice.invoice_number || invoice.stripe_invoice_id.substring(0, 14)}
                          </span>
                          {invoice.attempt_count && invoice.attempt_count > 0 && (
                            <span className="text-[10px] text-amber-400">
                              {invoice.attempt_count} intento{invoice.attempt_count > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <p className="font-medium text-foreground truncate max-w-[150px]">
                            {invoice.client?.full_name || invoice.customer_name || '—'}
                          </p>
                          <p className="text-[10px] text-muted-foreground truncate max-w-[150px]">
                            {invoice.client?.email || invoice.customer_email || '—'}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">{invoice.plan_interval || '—'}</span>
                          <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                            {invoice.product_name || invoice.plan_name || ''}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {invoice.stripe_created_at ? (
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(invoice.stripe_created_at), 'dd MMM yy', { locale: es })}
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {invoice.due_date ? (
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(invoice.due_date), 'dd MMM yy', { locale: es })}
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {invoice.automatically_finalizes_at ? (
                          <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(invoice.automatically_finalizes_at), 'dd MMM HH:mm', { locale: es })}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60">
                              {formatDistanceToNow(new Date(invoice.automatically_finalizes_at), { addSuffix: true, locale: es })}
                            </span>
                          </div>
                        ) : invoice.finalized_at ? (
                          <span className="text-xs text-emerald-400">Finalizada</span>
                        ) : invoice.paid_at ? (
                          <span className="text-xs text-emerald-400">
                            {format(new Date(invoice.paid_at), 'dd MMM yy', { locale: es })}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {invoice.status === 'open' && (
                            <Button
                              size="sm"
                              onClick={() => handleChargeInvoice(invoice)}
                              disabled={chargingInvoice === invoice.id}
                              className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                            >
                              {chargingInvoice === invoice.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <DollarSign className="h-4 w-4" />
                              )}
                              Cobrar
                            </Button>
                          )}
                          {invoice.pdf_url && (
                            <Button size="sm" variant="ghost" onClick={() => window.open(invoice.pdf_url!, '_blank')} title="Descargar PDF">
                              <Download className="h-4 w-4" />
                            </Button>
                          )}
                          {invoice.hosted_invoice_url && (
                            <Button size="sm" variant="outline" onClick={() => window.open(invoice.hosted_invoice_url!, '_blank')}>
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {sortedInvoices.length > 100 && (
              <div className="p-4 border-t border-border/50 text-center">
                <p className="text-sm text-muted-foreground">
                  Mostrando 100 de {sortedInvoices.length} facturas. Usa filtros o exporta CSV para ver todas.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
