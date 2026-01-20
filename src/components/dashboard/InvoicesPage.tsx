import { useState, useMemo } from 'react';
import { FileText, DollarSign, Clock, ExternalLink, Loader2, CheckCircle, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
import { useInvoices, Invoice } from '@/hooks/useInvoices';
import { toast } from 'sonner';
import { formatDistanceToNow, format, addDays, isAfter, isBefore } from 'date-fns';
import { es } from 'date-fns/locale';
import { invokeWithAdminKey } from '@/lib/adminApi';

type InvoiceFilter = 'all' | 'open' | 'draft' | 'scheduled' | 'unscheduled';
type DateRange = 'all' | '1d' | '7d' | '15d' | '30d' | '60d';

export function InvoicesPage() {
  const { invoices, isLoading, syncInvoices, totalPending, refetch } = useInvoices();
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [chargingInvoice, setChargingInvoice] = useState<string | null>(null);
  const [isChargingAll, setIsChargingAll] = useState(false);
  const [chargeProgress, setChargeProgress] = useState<{ current: number; total: number; recovered: number } | null>(null);

  // Get date range cutoff
  const getDateCutoff = (range: DateRange): Date | null => {
    const now = new Date();
    switch (range) {
      case '1d': return addDays(now, 1);
      case '7d': return addDays(now, 7);
      case '15d': return addDays(now, 15);
      case '30d': return addDays(now, 30);
      case '60d': return addDays(now, 60);
      default: return null;
    }
  };

  const filteredInvoices = useMemo(() => {
    let result = invoices;
    
    // Status filter
    switch (filter) {
      case 'open':
        result = result.filter((i: Invoice) => i.status === 'open');
        break;
      case 'draft':
        result = result.filter((i: Invoice) => i.status === 'draft');
        break;
      case 'scheduled':
        result = result.filter((i: Invoice) => i.next_payment_attempt);
        break;
      case 'unscheduled':
        result = result.filter((i: Invoice) => !i.next_payment_attempt && i.status !== 'draft');
        break;
    }

    // Date range filter (based on next_payment_attempt or created_at)
    const cutoff = getDateCutoff(dateRange);
    if (cutoff) {
      const now = new Date();
      result = result.filter((i: Invoice) => {
        const dateToCheck = i.next_payment_attempt 
          ? new Date(i.next_payment_attempt) 
          : i.created_at 
          ? new Date(i.created_at) 
          : null;
        
        if (!dateToCheck) return true; // Include if no date
        
        // Include invoices where next_payment_attempt is between now and cutoff
        // Or for created_at, include if created within the range
        if (i.next_payment_attempt) {
          return isAfter(dateToCheck, now) && isBefore(dateToCheck, cutoff);
        }
        return true; // Include drafts/unscheduled regardless
      });
    }
    
    // Sort by next payment attempt (soonest first)
    return result.sort((a, b) => {
      if (!a.next_payment_attempt) return 1;
      if (!b.next_payment_attempt) return -1;
      return new Date(a.next_payment_attempt).getTime() - new Date(b.next_payment_attempt).getTime();
    });
  }, [invoices, filter, dateRange]);

  const totalFiltered = filteredInvoices.reduce((sum, i) => sum + (i.amount_due || 0), 0);

  const handleChargeInvoice = async (invoice: Invoice) => {
    setChargingInvoice(invoice.id);
    try {
      const data = await invokeWithAdminKey('force-charge-invoice', { invoice_id: invoice.stripe_invoice_id });

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
    // Only charge open invoices from the filtered list (respects date range filter)
    const toCharge = filteredInvoices.filter((i: Invoice) => 
      i.status === 'open'
    );

    if (toCharge.length === 0) {
      toast.error('No hay facturas elegibles para cobrar en el rango seleccionado');
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

      // Rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    setIsChargingAll(false);
    setChargeProgress(null);
    refetch();

    toast.success(`Cobro masivo completado: $${(recovered / 100).toFixed(2)} recuperados, ${failed} fallidos`);
  };

  // Filter invoices by date range first, then calculate counts
  const dateFilteredInvoices = useMemo(() => {
    const cutoff = getDateCutoff(dateRange);
    if (!cutoff) return invoices;
    
    const now = new Date();
    return invoices.filter((i: Invoice) => {
      if (!i.next_payment_attempt) return true; // Include drafts/unscheduled
      const dateToCheck = new Date(i.next_payment_attempt);
      return isAfter(dateToCheck, now) && isBefore(dateToCheck, cutoff);
    });
  }, [invoices, dateRange]);

  const filterCounts = useMemo(() => ({
    all: dateFilteredInvoices.length,
    open: dateFilteredInvoices.filter((i: Invoice) => i.status === 'open').length,
    draft: dateFilteredInvoices.filter((i: Invoice) => i.status === 'draft').length,
    scheduled: dateFilteredInvoices.filter((i: Invoice) => i.next_payment_attempt).length,
    unscheduled: dateFilteredInvoices.filter((i: Invoice) => !i.next_payment_attempt && i.status !== 'draft').length,
  }), [dateFilteredInvoices]);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2 md:gap-3">
            <FileText className="h-6 w-6 md:h-8 md:w-8 text-blue-500" />
            Facturas
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            Gestiona facturas pendientes
          </p>
        </div>
        <div className="flex items-center gap-3 justify-between sm:justify-end">
          <div className="text-left sm:text-right">
            <p className="text-xl md:text-2xl font-bold text-foreground">${totalPending.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-xs text-muted-foreground">Total pendiente</p>
          </div>
          <Button
            onClick={() => syncInvoices.mutate()}
            disabled={syncInvoices.isPending}
            variant="outline"
            size="sm"
            className="touch-feedback"
          >
            {syncInvoices.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span className="hidden sm:inline ml-2">Sync</span>
          </Button>
        </div>
      </div>

      {/* Charge All Progress */}
      {chargeProgress && (
        <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs md:text-sm font-medium">Cobrando facturas...</span>
            <span className="text-xs text-muted-foreground">
              {chargeProgress.current}/{chargeProgress.total}
            </span>
          </div>
          <Progress value={(chargeProgress.current / chargeProgress.total) * 100} className="h-2" />
          <p className="text-xs text-emerald-400 mt-2">
            Recuperado: ${(chargeProgress.recovered / 100).toFixed(2)}
          </p>
        </div>
      )}

      {/* Filters - Stack on mobile */}
      <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
        <div className="flex flex-col gap-3">
          {/* Tabs - Scroll on mobile */}
          <div className="overflow-x-auto -mx-3 px-3">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as InvoiceFilter)}>
              <TabsList className="bg-muted/50 h-8 min-w-max">
                <TabsTrigger value="all" className="text-xs px-2 md:px-3">Todas ({filterCounts.all})</TabsTrigger>
                <TabsTrigger value="open" className="text-xs px-2 md:px-3">Abiertas ({filterCounts.open})</TabsTrigger>
                <TabsTrigger value="draft" className="text-xs px-2 md:px-3">Borrador ({filterCounts.draft})</TabsTrigger>
                <TabsTrigger value="scheduled" className="text-xs px-2 md:px-3">Prog ({filterCounts.scheduled})</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Date filter and actions */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
                <SelectTrigger className="w-24 md:w-32 bg-muted/50 border-border/50 text-xs md:text-sm h-8">
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="1d">1 día</SelectItem>
                  <SelectItem value="7d">7 días</SelectItem>
                  <SelectItem value="15d">15 días</SelectItem>
                  <SelectItem value="30d">30 días</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-muted-foreground text-xs hidden sm:flex">
                ${(totalFiltered / 100).toFixed(2)}
              </Badge>
              <Button
                onClick={handleChargeAll}
                disabled={isChargingAll || filteredInvoices.filter(i => i.status === 'open').length === 0}
                size="sm"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-xs touch-feedback"
              >
                {isChargingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DollarSign className="h-3.5 w-3.5" />}
                Cobrar
              </Button>
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
      ) : filteredInvoices.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card p-8 md:p-12 text-center">
          <CheckCircle className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-3 text-emerald-500/50" />
          <p className="text-sm text-muted-foreground mb-1">¡Sin facturas pendientes!</p>
        </div>
      ) : (
        <>
          {/* Mobile Cards */}
          <div className="md:hidden space-y-3">
            {filteredInvoices.map((invoice) => (
              <div key={invoice.id} className="rounded-xl border border-border/50 bg-card p-4 touch-feedback">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground text-sm truncate">{invoice.customer_email || 'Sin email'}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{invoice.stripe_invoice_id}</p>
                  </div>
                  <span className="text-lg font-bold text-foreground ml-2">
                    ${(invoice.amount_due / 100).toFixed(2)}
                  </span>
                </div>
                
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <Badge variant="outline" className={`text-xs ${
                    invoice.status === 'open' 
                      ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                      : invoice.status === 'draft'
                      ? 'bg-gray-500/10 text-gray-400 border-gray-500/30'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  }`}>
                    {invoice.status}
                  </Badge>
                  {invoice.next_payment_attempt && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDistanceToNow(new Date(invoice.next_payment_attempt), { addSuffix: true, locale: es })}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleChargeInvoice(invoice)}
                    disabled={chargingInvoice === invoice.id || invoice.status !== 'open'}
                    className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-xs h-8 flex-1 touch-feedback"
                  >
                    {chargingInvoice === invoice.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <DollarSign className="h-3.5 w-3.5" />
                    )}
                    Cobrar
                  </Button>
                  {invoice.hosted_invoice_url && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.open(invoice.hosted_invoice_url!, '_blank')}
                      className="h-8 touch-feedback"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block rounded-xl border border-border/50 bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50 hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Cliente</TableHead>
                    <TableHead className="text-muted-foreground">Monto</TableHead>
                    <TableHead className="text-muted-foreground">Estado</TableHead>
                    <TableHead className="text-muted-foreground">Próximo intento</TableHead>
                    <TableHead className="text-muted-foreground">Período</TableHead>
                    <TableHead className="text-right text-muted-foreground">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((invoice) => (
                    <TableRow key={invoice.id} className="border-border/50 hover:bg-muted/20">
                      <TableCell>
                        <p className="font-medium text-foreground">{invoice.customer_email || 'Sin email'}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {invoice.stripe_invoice_id}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="text-lg font-semibold text-foreground">
                          ${(invoice.amount_due / 100).toFixed(2)}
                        </span>
                        <span className="text-xs text-muted-foreground ml-1 uppercase">
                          {invoice.currency}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={
                          invoice.status === 'open' 
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                            : invoice.status === 'draft'
                            ? 'bg-gray-500/10 text-gray-400 border-gray-500/30'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                        }>
                          {invoice.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {invoice.next_payment_attempt ? (
                          <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm">
                              {formatDistanceToNow(new Date(invoice.next_payment_attempt), { addSuffix: true, locale: es })}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Sin programar</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {invoice.period_end ? (
                          <span className="text-sm text-muted-foreground">
                            {format(new Date(invoice.period_end), 'dd MMM yyyy', { locale: es })}
                          </span>
                        ) : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleChargeInvoice(invoice)}
                            disabled={chargingInvoice === invoice.id || invoice.status !== 'open'}
                            className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                          >
                            {chargingInvoice === invoice.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <DollarSign className="h-4 w-4" />
                            )}
                            Cobrar
                          </Button>
                          {invoice.hosted_invoice_url && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => window.open(invoice.hosted_invoice_url!, '_blank')}
                            >
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
          </div>
        </>
      )}
    </div>
  );
}
