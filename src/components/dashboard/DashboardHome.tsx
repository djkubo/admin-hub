import { useState, useMemo } from 'react';
import { useDailyKPIs, TimeFilter } from '@/hooks/useDailyKPIs';
import { useMetrics } from '@/hooks/useMetrics';
import { useInvoices } from '@/hooks/useInvoices';
import { useSubscriptions } from '@/hooks/useSubscriptions';
import { 
  DollarSign, 
  UserPlus, 
  RefreshCw, 
  ArrowRightCircle, 
  AlertTriangle,
  XCircle,
  Loader2,
  Clock,
  Zap,
  MessageCircle,
  FileText,
  ChevronRight,
  CheckCircle,
  CreditCard,
  ChevronDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDistanceToNow, addDays, addHours, subDays, subMonths, subYears } from 'date-fns';
import { es } from 'date-fns/locale';
import { openWhatsApp, getRecoveryMessage } from './RecoveryTable';
import type { RecoveryClient } from '@/lib/csvProcessor';
import { invokeWithAdminKey } from '@/lib/adminApi';

type SyncRange = 'today' | '7d' | 'month' | 'full';

const syncRangeLabels: Record<SyncRange, string> = {
  today: 'Hoy',
  '7d': '7 días',
  month: 'Mes',
  full: 'Todo el historial',
};

function getSyncDateRange(range: SyncRange): { startDate: Date; endDate: Date; fetchAll: boolean; maxPages: number } {
  const now = new Date();
  
  switch (range) {
    case 'today':
      return { 
        startDate: subDays(now, 1), 
        endDate: now, 
        fetchAll: true,
        maxPages: 5 
      };
    case '7d':
      return { 
        startDate: subDays(now, 7), 
        endDate: now, 
        fetchAll: true,
        maxPages: 20 
      };
    case 'month':
      return { 
        startDate: subMonths(now, 1), 
        endDate: now, 
        fetchAll: true,
        maxPages: 50 
      };
    case 'full':
      return { 
        startDate: subYears(now, 5), 
        endDate: now, 
        fetchAll: true,
        maxPages: 500 // Allow up to 50k transactions
      };
  }
}

interface DashboardHomeProps {
  lastSync?: Date | null;
  onNavigate?: (page: string) => void;
}

export function DashboardHome({ lastSync, onNavigate }: DashboardHomeProps) {
  const [filter, setFilter] = useState<TimeFilter>('today');
  const { kpis, isLoading, refetch } = useDailyKPIs(filter);
  const { metrics } = useMetrics();
  const { invoices, invoicesNext72h } = useInvoices();
  const { subscriptions } = useSubscriptions();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string>('');
  const [syncStatus, setSyncStatus] = useState<'ok' | 'warning' | null>(null);
  const queryClient = useQueryClient();

  const filterLabels: Record<TimeFilter, string> = {
    today: 'Hoy',
    '7d': '7d',
    month: 'Mes',
    all: 'Todo',
  };

  const handleSyncAll = async (range: SyncRange = 'today') => {
    setIsSyncing(true);
    setSyncStatus(null);
    setSyncProgress('');
    
    const { startDate, endDate, fetchAll, maxPages } = getSyncDateRange(range);
    const results = { stripe: 0, paypal: 0, subs: 0, invoices: 0, errors: 0 };

    toast.info(`Sincronizando ${syncRangeLabels[range]}...`);

    try {
      // 1. Stripe
      setSyncProgress('Stripe...');
      try {
        const stripeData = await invokeWithAdminKey('fetch-stripe', { 
          fetchAll, 
          startDate: startDate.toISOString(), 
          endDate: endDate.toISOString(),
          maxPages
        });
        results.stripe = stripeData?.synced_transactions || 0;
      } catch (e) {
        console.error('Stripe sync error:', e);
        results.errors++;
      }

      // 2. PayPal
      setSyncProgress('PayPal...');
      try {
        const paypalData = await invokeWithAdminKey('fetch-paypal', { 
          fetchAll, 
          startDate: startDate.toISOString(), 
          endDate: endDate.toISOString() 
        });
        results.paypal = paypalData?.synced_transactions || 0;
      } catch (e) {
        console.error('PayPal sync error:', e);
        results.errors++;
      }

      // 3. Subscriptions
      setSyncProgress('Suscripciones...');
      try {
        const subsData = await invokeWithAdminKey('fetch-subscriptions', {});
        results.subs = subsData?.synced || subsData?.upserted || 0;
      } catch (e) {
        console.error('Subscriptions sync error:', e);
        results.errors++;
      }

      // 4. Invoices
      setSyncProgress('Facturas...');
      try {
        const invoicesData = await invokeWithAdminKey('fetch-invoices', {});
        results.invoices = invoicesData?.synced || 0;
      } catch (e) {
        console.error('Invoices sync error:', e);
        results.errors++;
      }

      setSyncStatus(results.errors > 0 ? 'warning' : 'ok');
      setSyncProgress('');

      const totalTx = results.stripe + results.paypal;
      toast.success(`✅ ${syncRangeLabels[range]}: ${totalTx} tx, ${results.subs} subs, ${results.invoices} facturas${results.errors > 0 ? ` (${results.errors} errores)` : ''}`);
      
      // Invalidate all queries
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['daily-kpis'] });
      
      refetch();
    } catch (error) {
      console.error('Sync error:', error);
      setSyncStatus('warning');
      setSyncProgress('');
      toast.error('Error en sincronización');
    } finally {
      setIsSyncing(false);
    }
  };

  // Top 10 failed payments with phone
  const top10Failures = useMemo(() => {
    return metrics.recoveryList
      .filter((c: RecoveryClient) => c.phone)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
  }, [metrics.recoveryList]);

  // Top 10 invoices to collect soon
  const top10Invoices = useMemo(() => {
    return invoicesNext72h?.slice(0, 10) || [];
  }, [invoicesNext72h]);

  // Top 10 trials expiring in 24-48h
  const top10ExpiringTrials = useMemo(() => {
    const now = new Date();
    const in48h = addHours(now, 48);
    
    return subscriptions
      .filter(s => {
        if (s.status !== 'trialing' || !s.trial_end) return false;
        const trialEnd = new Date(s.trial_end);
        return trialEnd >= now && trialEnd <= in48h;
      })
      .sort((a, b) => new Date(a.trial_end!).getTime() - new Date(b.trial_end!).getTime())
      .slice(0, 10);
  }, [subscriptions]);

  const totalRevenue = kpis.newRevenue + kpis.conversionRevenue + kpis.renewalRevenue;
  const atRiskAmount = kpis.failuresToday * 50;

  const cards = [
    {
      title: 'Ventas',
      value: `$${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: DollarSign,
      color: 'emerald',
      subtitle: filterLabels[filter],
    },
    {
      title: 'Nuevos',
      value: kpis.newPayersToday,
      icon: UserPlus,
      color: 'cyan',
      subtitle: `$${kpis.newRevenue.toFixed(0)}`,
    },
    {
      title: 'Renovaciones',
      value: kpis.renewalsToday,
      icon: RefreshCw,
      color: 'green',
      subtitle: `$${kpis.renewalRevenue.toFixed(0)}`,
    },
    {
      title: 'Trial→Paid',
      value: kpis.trialConversionsToday,
      icon: ArrowRightCircle,
      color: 'purple',
      subtitle: `$${kpis.conversionRevenue.toFixed(0)}`,
    },
    {
      title: 'Fallos',
      value: kpis.failuresToday,
      icon: AlertTriangle,
      color: 'amber',
      subtitle: kpis.failuresToday > 0 ? `~$${atRiskAmount} riesgo` : 'OK',
      isNegative: true,
    },
    {
      title: 'Cancelaciones',
      value: kpis.cancellationsToday,
      icon: XCircle,
      color: 'red',
      subtitle: 'suscripciones',
      isNegative: true,
    },
  ];

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; icon: string; border: string }> = {
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', icon: 'text-emerald-500', border: 'border-emerald-500/30' },
      cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', icon: 'text-cyan-500', border: 'border-cyan-500/30' },
      green: { bg: 'bg-green-500/10', text: 'text-green-400', icon: 'text-green-500', border: 'border-green-500/30' },
      purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', icon: 'text-purple-500', border: 'border-purple-500/30' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: 'text-amber-500', border: 'border-amber-500/30' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400', icon: 'text-red-500', border: 'border-red-500/30' },
    };
    return colors[color] || colors.emerald;
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* A) Top Bar - Responsive */}
      <div className="bg-card rounded-xl border border-border/50 p-3 md:p-4">
        {/* Mobile: Stack vertically */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {/* Title + Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <h1 className="text-base md:text-lg font-semibold text-foreground">Command Center</h1>
            </div>
            
            {/* Time filter - scrollable on mobile */}
            <div className="flex rounded-lg border border-border/50 overflow-x-auto">
              {(['today', '7d', 'month', 'all'] as TimeFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 md:px-4 py-2 text-xs md:text-sm font-medium transition-colors whitespace-nowrap touch-feedback ${
                    filter === f
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {filterLabels[f]}
                </button>
              ))}
            </div>
          </div>

          {/* Sync section */}
          <div className="flex items-center justify-between sm:justify-end gap-3">
            {/* Last Sync Status - hide time text on mobile */}
            <div className="flex items-center gap-2 text-xs md:text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground hidden sm:inline">
                {lastSync ? formatDistanceToNow(lastSync, { addSuffix: true, locale: es }) : 'Sin sync'}
              </span>
              {syncStatus && (
                <Badge variant="outline" className={`text-xs ${syncStatus === 'ok' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/10 text-amber-400 border-amber-500/30'}`}>
                  {syncStatus === 'ok' ? <CheckCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                </Badge>
              )}
            </div>

            {/* Sync All Dropdown */}
            {isSyncing ? (
              <Button
                disabled
                size="sm"
                className="gap-2 bg-gradient-to-r from-purple-600 to-yellow-600 text-xs md:text-sm"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="hidden sm:inline">{syncProgress || 'Syncing...'}</span>
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="gap-1.5 bg-gradient-to-r from-purple-600 to-yellow-600 hover:from-purple-700 hover:to-yellow-700 text-xs md:text-sm touch-feedback"
                  >
                    <RefreshCw className="h-4 w-4" />
                    <span className="hidden sm:inline">Sync All</span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 bg-popover border-border">
                  <DropdownMenuItem onClick={() => handleSyncAll('today')} className="touch-feedback">
                    <Clock className="h-4 w-4 mr-2" />
                    Hoy (24h)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleSyncAll('7d')} className="touch-feedback">
                    <Clock className="h-4 w-4 mr-2" />
                    Últimos 7 días
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleSyncAll('month')} className="touch-feedback">
                    <Clock className="h-4 w-4 mr-2" />
                    Último mes
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleSyncAll('full')} className="text-amber-400 touch-feedback">
                    <Zap className="h-4 w-4 mr-2" />
                    Todo (3 años)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      {/* B) 6 KPI Cards - 2 cols on mobile, 3 on tablet, 6 on desktop */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 md:gap-4">
        {cards.map((card, index) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;

          if (isLoading) {
            return (
              <div key={index} className="rounded-xl border border-border/50 bg-card p-4 animate-pulse">
                <div className="h-8 w-8 rounded-lg bg-muted mb-2" />
                <div className="h-4 w-16 bg-muted rounded mb-1" />
                <div className="h-6 w-12 bg-muted rounded" />
              </div>
            );
          }

          return (
            <div
              key={index}
              className={`rounded-xl border ${colors.border} bg-card p-3 md:p-4 transition-all hover:shadow-lg touch-feedback`}
            >
              <div className={`inline-flex p-1.5 md:p-2 rounded-lg ${colors.bg} mb-1.5 md:mb-2`}>
                <Icon className={`h-3.5 w-3.5 md:h-4 md:w-4 ${colors.icon}`} />
              </div>
              <p className="text-[10px] md:text-xs text-muted-foreground">{card.title}</p>
              <p className={`text-lg md:text-2xl font-bold ${card.isNegative && typeof card.value === 'number' && card.value > 0 ? 'text-red-400' : 'text-foreground'}`}>
                {card.value}
              </p>
              <p className={`text-[9px] md:text-[10px] ${colors.text} mt-0.5`}>{card.subtitle}</p>
            </div>
          );
        })}
      </div>

      {/* C) 3 Short Lists with CTAs - Stack on mobile */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {/* Top 10 Failures with Phone */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="flex items-center justify-between p-3 md:p-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <h3 className="text-sm md:text-base font-semibold text-foreground">Fallos con Tel</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate?.('recovery')} className="text-xs gap-1 touch-feedback">
              Ver <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-border/30 max-h-[250px] md:max-h-[300px] overflow-y-auto">
            {top10Failures.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-sm">
                <CheckCircle className="h-6 w-6 md:h-8 md:w-8 mx-auto mb-2 text-emerald-500/50" />
                Sin fallos
              </div>
            ) : (
              top10Failures.map((client, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 md:p-3 hover:bg-muted/20 touch-feedback">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs md:text-sm font-medium text-foreground truncate">{client.full_name || client.email}</p>
                    <p className="text-[10px] md:text-xs text-red-400">${client.amount.toFixed(2)}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[#25D366] hover:bg-[#25D366]/10 h-8 w-8 p-0"
                    onClick={() => openWhatsApp(client.phone!, client.full_name || '', getRecoveryMessage(client.full_name || '', client.amount))}
                  >
                    <MessageCircle className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Top 10 Invoices to Collect */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="flex items-center justify-between p-3 md:p-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-500" />
              <h3 className="text-sm md:text-base font-semibold text-foreground">Por Cobrar</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate?.('invoices')} className="text-xs gap-1 touch-feedback">
              Ver <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-border/30 max-h-[250px] md:max-h-[300px] overflow-y-auto">
            {top10Invoices.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-sm">
                <CheckCircle className="h-6 w-6 md:h-8 md:w-8 mx-auto mb-2 text-emerald-500/50" />
                Sin pendientes
              </div>
            ) : (
              top10Invoices.map((invoice, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 md:p-3 hover:bg-muted/20 touch-feedback">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs md:text-sm font-medium text-foreground truncate">{invoice.customer_email || 'Sin email'}</p>
                    <p className="text-[10px] md:text-xs text-muted-foreground">
                      ${(invoice.amount_due / 100).toFixed(2)}
                    </p>
                  </div>
                  {invoice.hosted_invoice_url && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-blue-400 hover:bg-blue-500/10 h-8 w-8 p-0"
                      onClick={() => window.open(invoice.hosted_invoice_url!, '_blank')}
                    >
                      <FileText className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Top 10 Trials Expiring */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden md:col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between p-3 md:p-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-purple-500" />
              <h3 className="text-sm md:text-base font-semibold text-foreground">Trials por Vencer</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate?.('subscriptions')} className="text-xs gap-1 touch-feedback">
              Ver <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-border/30 max-h-[250px] md:max-h-[300px] overflow-y-auto">
            {top10ExpiringTrials.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-sm">
                <CheckCircle className="h-6 w-6 md:h-8 md:w-8 mx-auto mb-2 text-emerald-500/50" />
                Sin trials
              </div>
            ) : (
              top10ExpiringTrials.map((sub, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 md:p-3 hover:bg-muted/20 touch-feedback">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs md:text-sm font-medium text-foreground truncate">{sub.customer_email || 'Sin email'}</p>
                    <p className="text-[10px] md:text-xs text-muted-foreground">
                      {sub.plan_name}
                    </p>
                  </div>
                  <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30 text-[10px] md:text-xs">
                    {formatDistanceToNow(new Date(sub.trial_end!), { locale: es })}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Failure reasons inline */}
      {kpis.failureReasons.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap p-3 md:p-4 bg-card rounded-xl border border-border/50">
          <span className="text-[10px] md:text-xs text-amber-400 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Razones:
          </span>
          {kpis.failureReasons.slice(0, 3).map((reason, i) => (
            <Badge
              key={i}
              variant="outline"
              className="text-[10px] md:text-xs border-amber-500/30 text-amber-400 bg-amber-500/10"
            >
              {reason.reason}: {reason.count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
