import { useState, useMemo } from 'react';
import { FileText, DollarSign, Clock, ExternalLink, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
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
import { useInvoices, Invoice } from '@/hooks/useInvoices';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatDistanceToNow, format } from 'date-fns';
import { es } from 'date-fns/locale';

type InvoiceFilter = 'all' | 'open' | 'draft' | 'scheduled' | 'unscheduled';

export function InvoicesPage() {
  const { invoices, isLoading, syncInvoices, totalPending, refetch } = useInvoices();
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const [chargingInvoice, setChargingInvoice] = useState<string | null>(null);
  const [isChargingAll, setIsChargingAll] = useState(false);
  const [chargeProgress, setChargeProgress] = useState<{ current: number; total: number; recovered: number } | null>(null);

  const filteredInvoices = useMemo(() => {
    let result = invoices;
    
    switch (filter) {
      case 'open':
        result = invoices.filter((i: Invoice) => i.status === 'open');
        break;
      case 'draft':
        result = invoices.filter((i: Invoice) => i.status === 'draft');
        break;
      case 'scheduled':
        result = invoices.filter((i: Invoice) => i.next_payment_attempt);
        break;
      case 'unscheduled':
        result = invoices.filter((i: Invoice) => !i.next_payment_attempt && i.status !== 'draft');
        break;
    }
    
    // Sort by next payment attempt (soonest first)
    return result.sort((a, b) => {
      if (!a.next_payment_attempt) return 1;
      if (!b.next_payment_attempt) return -1;
      return new Date(a.next_payment_attempt).getTime() - new Date(b.next_payment_attempt).getTime();
    });
  }, [invoices, filter]);

  const totalFiltered = filteredInvoices.reduce((sum, i) => sum + (i.amount_due || 0), 0);

  const handleChargeInvoice = async (invoice: Invoice) => {
    setChargingInvoice(invoice.id);
    try {
      const { data, error } = await supabase.functions.invoke('force-charge-invoice', {
        body: { invoice_id: invoice.stripe_invoice_id },
      });

      if (error) throw error;

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
    // Only charge open invoices with scheduled payment
    const toCharge = filteredInvoices.filter((i: Invoice) => 
      i.status === 'open' && i.next_payment_attempt
    );

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
        const { data, error } = await supabase.functions.invoke('force-charge-invoice', {
          body: { invoice_id: invoice.stripe_invoice_id },
        });

        if (!error && data?.success) {
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

  const filterCounts = {
    all: invoices.length,
    open: invoices.filter((i: Invoice) => i.status === 'open').length,
    draft: invoices.filter((i: Invoice) => i.status === 'draft').length,
    scheduled: invoices.filter((i: Invoice) => i.next_payment_attempt).length,
    unscheduled: invoices.filter((i: Invoice) => !i.next_payment_attempt && i.status !== 'draft').length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <FileText className="h-8 w-8 text-blue-500" />
            Facturas Pendientes
          </h1>
          <p className="text-muted-foreground mt-1">
            Gestiona y cobra facturas pendientes de Stripe
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-2xl font-bold text-foreground">${(totalPending / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-sm text-muted-foreground">Total pendiente</p>
          </div>
          <Button
            onClick={() => syncInvoices.mutate()}
            disabled={syncInvoices.isPending}
            variant="outline"
          >
            {syncInvoices.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Sincronizar
          </Button>
        </div>
      </div>

      {/* Charge All Progress */}
      {chargeProgress && (
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Cobrando facturas...</span>
            <span className="text-sm text-muted-foreground">
              {chargeProgress.current}/{chargeProgress.total}
            </span>
          </div>
          <Progress value={(chargeProgress.current / chargeProgress.total) * 100} className="h-2" />
          <p className="text-xs text-emerald-400 mt-2">
            Recuperado: ${(chargeProgress.recovered / 100).toFixed(2)}
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as InvoiceFilter)}>
            <TabsList className="bg-muted/50">
              <TabsTrigger value="all">Todas ({filterCounts.all})</TabsTrigger>
              <TabsTrigger value="open">Abiertas ({filterCounts.open})</TabsTrigger>
              <TabsTrigger value="draft">Borrador ({filterCounts.draft})</TabsTrigger>
              <TabsTrigger value="scheduled">Programadas ({filterCounts.scheduled})</TabsTrigger>
              <TabsTrigger value="unscheduled">Sin programar ({filterCounts.unscheduled})</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-muted-foreground">
              ${(totalFiltered / 100).toFixed(2)} en {filteredInvoices.length} facturas
            </Badge>
            <Button
              onClick={handleChargeAll}
              disabled={isChargingAll || filter !== 'open'}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700"
            >
              {isChargingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <DollarSign className="h-4 w-4" />}
              Cobrar Todas
            </Button>
          </div>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl border border-border/50 bg-card p-12 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
          <p className="text-muted-foreground">Cargando facturas...</p>
        </div>
      ) : filteredInvoices.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card p-12 text-center">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-emerald-500/50" />
          <p className="text-muted-foreground mb-1">¡Sin facturas pendientes!</p>
          <p className="text-xs text-muted-foreground">Las facturas por cobrar aparecerán aquí</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
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
      )}
    </div>
  );
}
