import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
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
  ChevronDown,
  TrendingUp,
  Megaphone,
  ShieldAlert
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
import { formatDistanceToNow, addHours, subDays, subMonths, subYears } from 'date-fns';
import { es } from 'date-fns/locale';
import { openWhatsApp, getRecoveryMessage } from './RecoveryTable';
import type { RecoveryClient } from '@/lib/csvProcessor';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { SyncResultsPanel } from './SyncResultsPanel';
import type { 
  FetchStripeBody, 
  FetchStripeResponse, 
  FetchPayPalBody, 
  FetchPayPalResponse,
  FetchSubscriptionsResponse,
  FetchInvoicesBody,
  FetchInvoicesResponse,
  SyncCommandCenterBody,
  SyncCommandCenterResponse
} from '@/types/edgeFunctions';

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

// Route mapping for navigation
const routeMap: Record<string, string> = {
  analytics: "/analytics",
  movements: "/movements",
  clients: "/clients",
  subscriptions: "/subscriptions",
  recovery: "/recovery",
  invoices: "/invoices",
  campaigns: "/campaigns",
};

export function DashboardHome() {
  const navigate = useNavigate();
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [filter, setFilter] = useState<TimeFilter>('today');
  const { kpis, isLoading, refetch } = useDailyKPIs(filter);
  const { metrics } = useMetrics();
  const { invoicesNext72h } = useInvoices();
  const { subscriptions } = useSubscriptions();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string>('');
  const [syncStatus, setSyncStatus] = useState<'ok' | 'warning' | null>(null);
  const queryClient = useQueryClient();

  // Helper for navigation
  const handleNavigate = (page: string) => {
    const route = routeMap[page] || `/${page}`;
    navigate(route);
  };

  // Fetch last sync on mount
  useEffect(() => {
    const fetchLastSync = async () => {
      const { data } = await supabase
        .from('sync_runs')
        .select('completed_at')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (data?.completed_at) {
        setLastSync(new Date(data.completed_at));
      }
    };

    fetchLastSync();

    // Subscribe to sync_runs changes for real-time updates
    const channel = supabase
      .channel('sync-status-dashboard')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'sync_runs' },
        (payload) => {
          if (payload.eventType === 'UPDATE' && (payload.new as any).status === 'completed') {
            setLastSync(new Date((payload.new as any).completed_at));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const filterLabels: Record<TimeFilter, string> = {
    today: 'Hoy',
    '7d': '7d',
    month: 'Mes',
    all: 'Todo',
  };

  const handleForceCancel = async () => {
    try {
      setSyncProgress('Cancelando todos los syncs...');
      
      // Cancel ALL sync sources in parallel
      const cancelResults = await Promise.allSettled([
        invokeWithAdminKey<{ success: boolean; cancelled: number; message?: string }, { forceCancel: boolean }>(
          'fetch-stripe',
          { forceCancel: true }
        ),
        invokeWithAdminKey<{ success: boolean; cancelled: number; message?: string }, { forceCancel: boolean }>(
          'fetch-paypal',
          { forceCancel: true }
        ),
        invokeWithAdminKey<{ ok: boolean; cancelled: number; message?: string }, { forceCancel: boolean }>(
          'sync-ghl',
          { forceCancel: true }
        ),
        invokeWithAdminKey<{ ok: boolean; cancelled: number; message?: string }, { forceCancel: boolean }>(
          'sync-manychat',
          { forceCancel: true }
        ),
      ]);
      
      // Count total cancelled
      let totalCancelled = 0;
      for (const result of cancelResults) {
        if (result.status === 'fulfilled' && result.value) {
          const val = result.value as { cancelled?: number };
          totalCancelled += val.cancelled || 0;
        }
      }
      
      toast.success('Todos los syncs cancelados', {
        description: `Se cancelaron ${totalCancelled} sincronizaciones en total`,
      });
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
    } catch (error) {
      console.error('Force cancel error:', error);
      toast.error('Error al cancelar', {
        description: error instanceof Error ? error.message : 'Error desconocido',
      });
    } finally {
      setSyncProgress('');
      setIsSyncing(false);
    }
  };

  const handleSyncAll = async (range: SyncRange = 'today') => {
    // Prevent multiple clicks
    if (isSyncing) {
      toast.warning('Ya hay una sincronización en progreso');
      return;
    }
    
    setIsSyncing(true);
    setSyncStatus(null);
    setSyncProgress('');
    
    // Show appropriate toast based on range size
    const isLargeRange = range === 'month' || range === 'full';
    if (isLargeRange) {
      toast.info(`🚀 Sincronización masiva iniciada en segundo plano`, {
        description: 'Los datos aparecerán progresivamente en los próximos minutos.',
        duration: 8000,
      });
    } else {
      toast.info(`Sincronizando ${syncRangeLabels[range]}...`);
    }

    try {
      // Use sync-command-center for orchestrated sync
      setSyncProgress('Iniciando sync completo...');
      console.log('[Command Center] Starting sync with mode:', range);
      
      const commandCenterData = await invokeWithAdminKey<SyncCommandCenterResponse, SyncCommandCenterBody>(
        'sync-command-center',
        {
          mode: range,
          includeContacts: false, // Don't sync contacts by default (can be slow)
        }
      );

      console.log('[Command Center] Response received:', {
        hasData: !!commandCenterData,
        success: commandCenterData?.success,
        error: commandCenterData?.error,
        status: commandCenterData?.status
      });

      if (!commandCenterData) {
        console.error('[Command Center] No response from server');
        throw new Error('No se recibió respuesta del servidor. Verifica la consola para más detalles.');
      }

      if (commandCenterData.error) {
        console.error('[Command Center] Error in response:', commandCenterData.error);
        throw new Error(commandCenterData.error);
      }

      if (!commandCenterData.success) {
        console.error('[Command Center] Sync failed without details');
        throw new Error(commandCenterData.error || 'El sync falló sin detalles');
      }

      // Extract results from command center response
      const results = commandCenterData.results || {};
      const failedSteps = commandCenterData.failedSteps || [];
      const totalRecords = commandCenterData.totalRecords || 0;

      // Calculate totals
      const stripeCount = results.stripe?.count || 0;
      const paypalCount = results.paypal?.count || 0;
      const subsCount = results.subscriptions?.count || 0;
      const invoicesCount = results.invoices?.count || 0;
      const errorsCount = failedSteps.length;

      setSyncStatus(errorsCount > 0 ? 'warning' : 'ok');
      setSyncProgress('');

      // Show detailed results
      if (commandCenterData.status === 'completed_with_timeout') {
        toast.warning(`⏱️ Sync completado parcialmente (timeout)`, {
          description: `Se sincronizaron ${totalRecords} registros antes del límite de tiempo. Algunos pasos fueron omitidos.`,
          duration: 10000,
        });
      } else if (errorsCount > 0) {
        const errorDetails = failedSteps.map(step => {
          const stepResult = results[step];
          const error = stepResult?.error || 'Error desconocido';
          return `${step}: ${error === 'Timeout' ? 'Se agotó el tiempo' : error}`;
        }).join(', ');
        
        toast.warning(`Sync completado con ${errorsCount} error(es)`, {
          description: errorDetails,
          duration: 8000,
        });
      } else {
        toast.success(`✅ ${syncRangeLabels[range]}: ${totalRecords} registros sincronizados`, {
          description: `Stripe: ${stripeCount}, PayPal: ${paypalCount}, Subs: ${subsCount}, Facturas: ${invoicesCount}`,
        });
      }
      
      // Invalidate all queries
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['daily-kpis'] });
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
      
      refetch();
    } catch (error) {
      console.error('Sync error:', error);
      setSyncStatus('warning');
      setSyncProgress('');
      
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido en sincronización';
      
      // Handle 409 sync_already_running error with action button
      if (errorMessage.includes('sync_already_running') || errorMessage.includes('sync en progreso')) {
        toast.warning('Sincronización en progreso', {
          description: 'Ya hay una sincronización activa. Puedes cancelarla y reiniciar.',
          duration: 10000,
          action: {
            label: 'Cancelar y reiniciar',
            onClick: async () => {
              await handleForceCancel();
              // Wait a bit then restart
              setTimeout(() => handleSyncAll(range), 1000);
            },
          },
        });
      } else {
        toast.error('Error en sincronización', {
          description: errorMessage,
          duration: 6000,
        });
      }
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

  // Card definitions with navigation targets
  const cards = [
    {
      title: 'MRR',
      value: `$${kpis.mrr.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: TrendingUp,
      color: 'primary',
      subtitle: `${kpis.mrrActiveCount.toLocaleString()} activas`,
      navigateTo: 'analytics',
      isHighlight: true,
    },
    {
      title: 'Ventas Netas',
      value: `$${kpis.newRevenue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: DollarSign,
      color: 'emerald',
      subtitle: filterLabels[filter],
      navigateTo: 'movements',
    },
    {
      title: 'Nuevos',
      value: kpis.newPayersToday,
      icon: UserPlus,
      color: 'neutral',  // VRP: All non-critical KPIs use neutral zinc
      subtitle: `$${kpis.newRevenue.toFixed(0)}`,
      navigateTo: 'clients',
    },
    {
      title: 'Trials',
      value: kpis.trialsStartedToday,
      icon: Clock,
      color: 'neutral',  // VRP: Neutral instead of blue
      subtitle: 'iniciados',
      navigateTo: 'subscriptions',
    },
    {
      title: 'Trial→Paid',
      value: kpis.trialConversionsToday,
      icon: ArrowRightCircle,
      color: 'neutral',  // VRP: Neutral instead of purple
      subtitle: `$${kpis.conversionRevenue.toFixed(0)}`,
      navigateTo: 'subscriptions',
    },
    {
      title: 'Renovaciones',
      value: kpis.renewalsToday,
      icon: RefreshCw,
      color: 'neutral',  // VRP: Neutral instead of green
      subtitle: `$${kpis.renewalRevenue.toFixed(0)}`,
      navigateTo: 'subscriptions',
    },
    {
      title: 'En Riesgo',
      value: `$${kpis.revenueAtRisk.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: ShieldAlert,
      color: 'red',
      subtitle: `${kpis.revenueAtRiskCount.toLocaleString()} facturas`,
      isNegative: true,
      navigateTo: 'recovery',
      isWarning: kpis.revenueAtRisk > 10000,
    },
    {
      title: 'Cancelaciones',
      value: kpis.cancellationsToday,
      icon: XCircle,
      color: 'amber',
      subtitle: 'suscripciones',
      isNegative: true,
      navigateTo: 'subscriptions',
    },
  ];

  // VRP Style: Neutral zinc palette with semantic exceptions only
  const getColorClasses = (color: string, isNegative?: boolean) => {
    // Semantic colors for negative/warning states
    if (color === 'red' || isNegative) {
      return { bg: 'bg-red-500/10', text: 'text-red-400', icon: 'text-red-500', border: 'border-red-500/30' };
    }
    if (color === 'amber') {
      return { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: 'text-amber-500', border: 'border-amber-500/30' };
    }
    // All other KPIs use neutral zinc + primary accent
    return { bg: 'bg-zinc-800', text: 'text-foreground', icon: 'text-primary', border: 'border-zinc-700' };
  };

  return (
    <div className="space-y-6">
      {/* A) Top Bar - Premium clean style */}
      <div className="bg-card rounded-lg border border-border p-4 md:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          {/* Title + Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <h1 className="text-lg md:text-xl font-display uppercase tracking-wide text-foreground">Command Center</h1>
            </div>
            
            {/* Time filter - clean pill style */}
            <div className="flex rounded-md border border-border overflow-hidden">
              {(['today', '7d', 'month', 'all'] as TimeFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 md:px-4 py-2 text-xs md:text-sm font-medium transition-colors whitespace-nowrap touch-feedback ${
                    filter === f
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                >
                  {filterLabels[f]}
                </button>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between sm:justify-end gap-2 md:gap-3">
            {/* Last Sync Status - hide time text on mobile */}
            <div className="flex items-center gap-2 text-xs md:text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground hidden sm:inline">
                {lastSync ? formatDistanceToNow(lastSync, { addSuffix: true, locale: es }) : 'Sin sync'}
              </span>
              {syncStatus && (
                <Badge variant="outline" className={`text-xs ${syncStatus === 'ok' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                  {syncStatus === 'ok' ? <CheckCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                </Badge>
              )}
            </div>

            {/* Broadcast Button */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleNavigate('campaigns')}
              className="gap-1.5 text-xs md:text-sm touch-feedback"
            >
              <Megaphone className="h-4 w-4" />
              <span className="hidden sm:inline">Broadcast</span>
            </Button>

            {/* Sync All Dropdown */}
            {isSyncing ? (
              <Button
                disabled
                size="sm"
                className="gap-2 bg-primary/80 text-xs md:text-sm"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="hidden sm:inline">{syncProgress || 'Syncing...'}</span>
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="gap-1.5 bg-primary hover:bg-primary/90 text-xs md:text-sm touch-feedback"
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

      {/* B) 8 KPI Cards - Clean, minimal */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        {cards.map((card, index) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;

          if (isLoading) {
            return (
              <div key={index} className="rounded-lg border border-border bg-card p-4 animate-pulse">
                <div className="h-8 w-8 rounded-md bg-muted mb-2" />
                <div className="h-4 w-16 bg-muted rounded mb-1" />
                <div className="h-6 w-12 bg-muted rounded" />
              </div>
            );
          }

          const isWarningCard = 'isWarning' in card && card.isWarning;
          const isHighlightCard = 'isHighlight' in card && card.isHighlight;

          return (
            <div
              key={index}
              onClick={() => card.navigateTo && handleNavigate(card.navigateTo)}
              className={`rounded-lg border ${
                isWarningCard 
                  ? 'border-red-500/30 bg-red-500/5' 
                  : isHighlightCard
                  ? 'border-primary/30 bg-primary/5'
                  : 'border-border bg-card'
              } p-4 transition-all hover:bg-accent/50 cursor-pointer touch-feedback group`}
            >
              <div className={`inline-flex p-2 rounded-md ${colors.bg} mb-2`}>
                <Icon className={`h-4 w-4 ${colors.icon}`} />
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {card.title}
                <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </p>
              <p className={`text-lg md:text-xl font-semibold ${
                card.isNegative 
                  ? 'text-red-400' 
                  : isHighlightCard 
                  ? 'text-primary' 
                  : 'text-foreground'
              }`}>
                {card.value}
              </p>
              <p className={`text-[10px] ${colors.text} mt-0.5`}>{card.subtitle}</p>
            </div>
          );
        })}
      </div>

      {/* Sync Results Panel - Shows sync status and recent results */}
      <SyncResultsPanel />

      {/* C) 3 Short Lists with CTAs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Top 10 Failures with Phone */}
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">Fallos con Tel</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => handleNavigate('recovery')} className="text-xs gap-1 touch-feedback">
              Ver <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
            {top10Failures.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-sm">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
                Sin fallos
              </div>
            ) : (
              top10Failures.map((client, i) => (
                <div key={i} className="flex items-center justify-between p-3 hover:bg-accent/50 touch-feedback">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{client.full_name || client.email}</p>
                    <p className="text-xs text-red-400">${client.amount.toFixed(2)}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-primary hover:bg-primary/10 h-8 w-8 p-0"
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
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">Por Cobrar</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => handleNavigate('invoices')} className="text-xs gap-1 touch-feedback">
              Ver <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
            {top10Invoices.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-sm">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
                Sin pendientes
              </div>
            ) : (
              top10Invoices.map((invoice, i) => (
                <div key={i} className="flex items-center justify-between p-3 hover:bg-accent/50 touch-feedback">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{invoice.customer_email || 'Sin email'}</p>
                    <p className="text-xs text-muted-foreground">
                      ${(invoice.amount_due / 100).toFixed(2)}
                    </p>
                  </div>
                  {invoice.hosted_invoice_url && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-primary hover:bg-primary/10 h-8 w-8 p-0"
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
        <div className="rounded-lg border border-border bg-card overflow-hidden md:col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">Trials por Vencer</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => handleNavigate('subscriptions')} className="text-xs gap-1 touch-feedback">
              Ver <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
          <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
            {top10ExpiringTrials.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-sm">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
                Sin trials
              </div>
            ) : (
              top10ExpiringTrials.map((sub, i) => (
                <div key={i} className="flex items-center justify-between p-3 hover:bg-accent/50 touch-feedback">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{sub.customer_email || 'Sin email'}</p>
                    <p className="text-xs text-muted-foreground">
                      {sub.plan_name}
                    </p>
                  </div>
                  <Badge variant="outline" className="bg-zinc-800 text-white border-zinc-700 text-xs">
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
        <div className="flex items-center gap-2 flex-wrap p-4 bg-card rounded-lg border border-border">
          <span className="text-xs text-amber-400 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Razones:
          </span>
          {kpis.failureReasons.slice(0, 3).map((reason, i) => (
            <Badge
              key={i}
              variant="outline"
              className="text-xs border-amber-500/20 text-amber-400 bg-amber-500/10"
            >
              {reason.reason}: {reason.count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
